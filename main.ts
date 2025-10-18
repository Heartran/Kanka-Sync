import {
  App,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  requestUrl,
  normalizePath,
  stringifyYaml,
} from "obsidian";

type KankaSettings = {
  apiToken: string;
  campaignId: string;
  outputFolder: string;
  groupByType: boolean;
  skipPrivate: boolean;
  excludedTypes: string[];
  apiThrottleMs: number;
};

const DEFAULT_SETTINGS: KankaSettings = {
  apiToken: "",
  campaignId: "",
  outputFolder: "Kanka",
  groupByType: true,
  skipPrivate: true,
  excludedTypes: ["race", "family"],
  apiThrottleMs: 600,
};

type KankaEntitySummary = {
  id: number;
  name: string;
  type?: string;
  entity_type?: string;
  slug?: string;
  is_private?: boolean;
};

type EntityIndexEntry = {
  id: string;
  name: string;
  path: string;
  type?: string;
  slug?: string;
};

type LocalIndex = {
  byId: Map<string, EntityIndexEntry>;
  byName: Map<string, EntityIndexEntry>;
};

export default class KankaSyncPlugin extends Plugin {
  settings: KankaSettings;

  private entityIndex: Map<string, EntityIndexEntry> = new Map();
  private nameIndex: Map<string, EntityIndexEntry> = new Map();
  private usedPaths: Set<string> = new Set();
  private lastRequestAt = 0;
  private abortSync = false;

  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.addSettingTab(new KankaSettingsTab(this.app, this));

    this.addCommand({
      id: "kanka-sync-pull-markdown",
      name: "Download all Kanka entities (markdown)",
      callback: () => void this.syncAllEntities(),
    });

    this.addCommand({
      id: "kanka-sync-rename-all",
      name: "Rename all Kanka notes from frontmatter",
      callback: () => void this.renameAllNotes(),
    });

    this.addCommand({
      id: "kanka-sync-fix-links",
      name: "Fix Kanka links in existing notes",
      callback: () => void this.fixAllLinks(),
    });
  }

  onunload() {
    this.abortSync = true;
  }

  private async syncAllEntities() {
    if (!this.ensureConfigured()) return;

    try {
      this.abortSync = false;
      new Notice("Kanka Sync: download avviato…");

      this.entityIndex.clear();
      this.nameIndex.clear();
      this.usedPaths.clear();

      const summaries = await this.fetchAllSummaries();
      if (this.abortSync) return;

      const filtered = summaries.filter((summary) => {
        if (this.settings.skipPrivate && summary.is_private) return false;
        const type = summary.type ?? summary.entity_type ?? "";
        if (this.isTypeExcluded(type)) return false;
        return true;
      });

      filtered.forEach((summary) => {
        this.buildAndRegisterEntry(summary);
      });

      let created = 0;
      let updated = 0;
      let skipped = 0;
      let failed = 0;

      for (const summary of filtered) {
        if (this.abortSync) break;
        try {
          const markdown = await this.fetchMarkdown(summary.id);
          const entry = this.entityIndex.get(String(summary.id));
          if (!entry) continue;
          const processed = this.prepareMarkdown(markdown, summary);
          const result = await this.writeEntityFile(entry.path, processed);
          if (result === "created") created += 1;
          else if (result === "updated") updated += 1;
          else skipped += 1;
        } catch (error) {
          failed += 1;
          console.error(`Kanka Sync: errore su entità #${summary.id}`, error);
        }
      }

      if (this.abortSync) {
        new Notice("Kanka Sync: download interrotto.");
        return;
      }

      const parts = [`${created} create`, `${updated} aggiornate`, `${skipped} invariata`];
      if (failed) parts.push(`${failed} errori`);
      new Notice(`Kanka Sync: ${parts.join(", ")}`);
    } catch (error: any) {
      console.error(error);
      new Notice(`Kanka Sync: errore — ${error?.message || error}`);
    }
  }

  private ensureConfigured(): boolean {
    if (!this.settings.apiToken.trim() || !this.settings.campaignId.trim()) {
      new Notice("Kanka Sync: configura API token e campaign ID nelle impostazioni.");
      return false;
    }
    return true;
  }

  private async fetchAllSummaries(): Promise<KankaEntitySummary[]> {
    const collected: KankaEntitySummary[] = [];
    let page = 1;

    while (!this.abortSync) {
      const response = await this.apiRequest<{ data: KankaEntitySummary[]; meta?: any }>(
        `/entities?page=${page}`
      );
      const data = response?.data ?? [];
      if (!data.length) break;
      collected.push(...data);

      const totalPages = response.meta?.pagination?.total_pages ?? page;
      if (page >= totalPages) break;
      page += 1;
    }

    return collected;
  }

  private async fetchMarkdown(entityId: number): Promise<string> {
    await this.throttle();
    const campaignId = this.settings.campaignId.trim();
    const response = await requestUrl({
      url: `https://app.kanka.io/w/${encodeURIComponent(campaignId)}/entities/${entityId}.md`,
      method: "GET",
      headers: {
        "Authorization": `Bearer ${this.settings.apiToken.trim()}`,
        "Accept": "text/markdown, text/plain;q=0.8, */*;q=0.5",
      },
      throw: true,
    });
    return response.text ?? response.body ?? "";
  }

  private async writeEntityFile(path: string, content: string): Promise<"created" | "updated" | "skipped"> {
    const normalized = normalizePath(path);
    const folder = normalized.split("/").slice(0, -1).join("/");
    if (folder) await this.ensureFolder(folder);

    const existing = this.app.vault.getAbstractFileByPath(normalized);
    if (existing instanceof TFile) {
      const current = await this.app.vault.read(existing);
      if (current === content) return "skipped";
      await this.app.vault.modify(existing, content);
      return "updated";
    } else {
      await this.app.vault.create(normalized, content);
      return "created";
    }
  }

  private prepareMarkdown(markdown: string, summary: KankaEntitySummary): string {
    const stripped = this.stripFrontmatter(markdown).trim();
    const hasHeading = stripped.startsWith("#");
    const heading = summary.name ? `# ${summary.name.trim()}` : "";
    const body = hasHeading ? stripped : [heading, stripped].filter(Boolean).join("\n\n");
    const convertedBody = this.convertReferences(body);

    const frontmatter = {
      kanka_id: summary.id,
      name: summary.name,
      type: summary.type ?? summary.entity_type ?? undefined,
      entity_type: summary.entity_type ?? undefined,
      kanka_slug: summary.slug ?? undefined,
      kanka_synced_at: new Date().toISOString(),
    };

    const yaml = stringifyYaml(frontmatter).trimEnd();
    return `---\n${yaml}\n---\n\n${convertedBody}`.trimEnd() + "\n";
  }

  private stripFrontmatter(markdown: string): string {
    if (markdown.startsWith("---")) {
      const closing = markdown.indexOf("\n---", 3);
      if (closing !== -1) return markdown.slice(closing + 4).replace(/^\s+/, "");
    }
    return markdown;
  }

  private buildAndRegisterEntry(summary: KankaEntitySummary) {
    const id = String(summary.id);
    const segments = this.computeFolderSegments(summary.type ?? summary.entity_type);
    const basename = this.buildBasename(id, summary.name, summary.slug);
    const basePath = [segments.join("/"), `${basename}.md`].filter(Boolean).join("/");
    const uniquePath = this.reserveUniquePath(basePath, id);

    const entry: EntityIndexEntry = {
      id,
      name: summary.name,
      path: uniquePath,
      type: summary.type ?? summary.entity_type ?? undefined,
      slug: summary.slug ?? undefined,
    };

    this.entityIndex.set(id, entry);
    this.registerName(entry.name, entry);
    if (entry.slug) this.registerName(entry.slug, entry);
  }

  private registerName(source: string, entry: EntityIndexEntry) {
    const normalized = this.normalizeName(source);
    if (!normalized) return;
    if (!this.nameIndex.has(normalized)) {
      this.nameIndex.set(normalized, entry);
    }
  }

  private normalizeName(value: string): string {
    return value
      .toLowerCase()
      .replace(/"[^"]*"/g, "")
      .replace(/\([^)]*\)/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .replace(/\s+/g, " ");
  }

  private computeFolderSegments(type?: string | null): string[] {
    const segments: string[] = [];
    const base = this.settings.outputFolder.trim();
    if (base) segments.push(base);
    if (this.settings.groupByType && type) segments.push(this.slugify(type));
    return segments;
  }

  private slugify(value: string): string {
    return value
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase();
  }

  private sanitizeFileName(name: string): string {
    return name
      .trim()
      .replace(/[\\/:*?"<>|]/g, "-")
      .replace(/\s+/g, " ")
      .replace(/^\.+/, "")
      .replace(/\.+$/, "");
  }

  private splitPath(fullPath: string): { base: string; ext: string } {
    const normalized = normalizePath(fullPath);
    const dot = normalized.lastIndexOf(".");
    if (dot === -1) return { base: normalized, ext: "" };
    return {
      base: normalized.slice(0, dot),
      ext: normalized.slice(dot),
    };
  }

  private reserveUniquePath(path: string, id: string): string {
    let candidate = normalizePath(path);
    if (!this.usedPaths.has(candidate.toLowerCase())) {
      this.usedPaths.add(candidate.toLowerCase());
      return candidate;
    }

    const { base, ext } = this.splitPath(candidate);

    const withId = `${base} (${id})${ext}`;
    if (!this.usedPaths.has(withId.toLowerCase())) {
      this.usedPaths.add(withId.toLowerCase());
      return withId;
    }

    let counter = 2;
    while (true) {
      const option = `${base} (${counter})${ext}`;
      if (!this.usedPaths.has(option.toLowerCase())) {
        this.usedPaths.add(option.toLowerCase());
        return option;
      }
      counter += 1;
    }
  }

  private async ensureFolder(path: string) {
    const normalized = normalizePath(path);
    if (!normalized) return;
    const adapter = this.app.vault.adapter;
    if (await adapter.exists(normalized)) return;

    const parts = normalized.split("/");
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!(await adapter.exists(current))) {
        await this.app.vault.createFolder(current);
      }
    }
  }

  private convertReferences(markdown: string): string {
    if (!markdown) return markdown;

    const resolver = (id: string) => {
      const entry = this.entityIndex.get(id);
      if (!entry) return null;
      return `[[${entry.path}|${entry.name}]]`;
    };

    const byName = (label: string) => {
      const entry = this.resolveByName(label);
      if (!entry) return null;
      return `[[${entry.path}|${entry.name}]]`;
    };

    const campaign = this.settings.campaignId.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const basePattern = `(?:https?:\\/\\/(?:www\\.)?app\\.kanka\\.io|\\/)?\\/w\\/${campaign}\\/entities\\/(\\d+)(?:[^\\s\\)]*)?`;
    const linkRegex = new RegExp(`\\[([^\\]]+)\\]\\((?=${basePattern})[^\\)]+\\)`, "gi");
    const bareRegex = new RegExp(basePattern, "gi");

    const withLinks = markdown.replace(linkRegex, (match, text) => {
      const idMatch = match.match(new RegExp(basePattern, "i"));
      if (!idMatch) return match;
      return resolver(idMatch[1]) ?? match;
    });

    const withBare = withLinks.replace(bareRegex, (match, entityId) => resolver(entityId) ?? match);
    const withTokens = this.replaceEntityTokens(withBare, (id) => resolver(id));
    return this.replaceHashLinks(withTokens, byName);
  }

  private convertReferencesWithIndex(markdown: string, index: LocalIndex): string {
    if (!markdown) return markdown;

    const resolveId = (id: string) => {
      const entry = index.byId.get(id);
      if (!entry) return null;
      return `[[${entry.path}|${entry.name}]]`;
    };

    const resolveName = (label: string) => {
      const entry = this.resolveByName(label, index.byName);
      if (!entry) return null;
      return `[[${entry.path}|${entry.name}]]`;
    };

    const campaign = this.settings.campaignId.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const basePattern = `(?:https?:\\/\\/(?:www\\.)?app\\.kanka\\.io|\\/)?\\/w\\/${campaign}\\/entities\\/(\\d+)(?:[^\\s\\)]*)?`;
    const linkRegex = new RegExp(`\\[([^\\]]+)\\]\\((?=${basePattern})[^\\)]+\\)`, "gi");
    const bareRegex = new RegExp(basePattern, "gi");

    const withLinks = markdown.replace(linkRegex, (match, text) => {
      const idMatch = match.match(new RegExp(basePattern, "i"));
      if (!idMatch) return match;
      return resolveId(idMatch[1]) ?? match;
    });

    const withBare = withLinks.replace(bareRegex, (match, entityId) => resolveId(entityId) ?? match);
    const withTokens = this.replaceEntityTokens(withBare, (id) => resolveId(id));
    return this.replaceHashLinks(withTokens, resolveName);
  }

  private replaceEntityTokens(
    markdown: string,
    resolver: (id: string, type?: string) => string | null
  ): string {
    return markdown.replace(/\[([a-z_]+):(\d+)\]/gi, (match, type, id) => resolver(id, type) ?? match);
  }

  private replaceHashLinks(
    markdown: string,
    resolver: (label: string) => string | null
  ): string {
    return markdown.replace(/\[([^\]]+)\]\(#\)/gi, (match, label) => resolver(label) ?? match);
  }

  private resolveByName(label: string, map: Map<string, EntityIndexEntry> = this.nameIndex): EntityIndexEntry | null {
    const normalized = this.normalizeName(label);
    if (!normalized) return null;
    return map.get(normalized) ?? null;
  }

  private async throttle() {
    const wait = Math.max(0, this.settings.apiThrottleMs);
    if (wait <= 0) {
      this.lastRequestAt = Date.now();
      return;
    }

    const now = Date.now();
    const elapsed = now - this.lastRequestAt;
    if (elapsed < wait) await this.delay(wait - elapsed);
    this.lastRequestAt = Date.now();
  }

  private delay(ms: number) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  private isTypeExcluded(type?: string | null): boolean {
    if (!type) return false;
    const normalized = type.toLowerCase().trim();
    if (!normalized) return false;

    const candidates = normalized.endsWith("s")
      ? [normalized, normalized.slice(0, -1)]
      : [normalized, `${normalized}s`];

    const excluded = this.settings.excludedTypes
      .map((value) => value.toLowerCase().trim())
      .filter(Boolean);

    return candidates.some((candidate) => excluded.includes(candidate));
  }

  private async apiRequest<T>(path: string): Promise<T> {
    await this.throttle();
    const campaignId = this.settings.campaignId.trim();
    const response = await requestUrl({
      url: `https://api.kanka.io/1.0/campaigns/${encodeURIComponent(campaignId)}${path}`,
      method: "GET",
      headers: {
        "Authorization": `Bearer ${this.settings.apiToken.trim()}`,
        "Accept": "application/json",
      },
      throw: true,
    });
    return response.json as T;
  }

  private async renameAllNotes(): Promise<void> {
    try {
      const folder = this.settings.outputFolder.trim();
      if (!folder) {
        new Notice("Kanka Sync: configura la cartella di output nelle impostazioni.");
        return;
      }

      const files = this.app.vault
        .getMarkdownFiles()
        .filter((file) => file.path.startsWith(folder));

      if (!files.length) {
        new Notice("Kanka Sync: nessuna nota Kanka trovata nella cartella di output.");
        return;
      }

      const occupied = new Set<string>();
      for (const file of files) occupied.add(file.path.toLowerCase());

      let renamed = 0;
      let skipped = 0;

      for (const file of files) {
        const cache = this.app.metadataCache.getFileCache(file);
        const name = cache?.frontmatter?.name?.toString().trim();
        const kankaId = cache?.frontmatter?.kanka_id ?? cache?.frontmatter?.kankaID;
        const entityType = cache?.frontmatter?.type ?? cache?.frontmatter?.entity_type ?? "";
        const slug = cache?.frontmatter?.kanka_slug ?? "";

        occupied.delete(file.path.toLowerCase());

        if (!name) {
          skipped += 1;
          occupied.add(file.path.toLowerCase());
          continue;
        }

        const segments = this.computeFolderSegments(entityType);
        const basename = this.buildBasename(
          kankaId ?? this.extractIdFromFilename(file.basename),
          name,
          slug
        );
        const desiredPath = normalizePath([segments.join("/"), `${basename}.md`].filter(Boolean).join("/"));
        const targetPath = this.findRenameTarget(desiredPath, occupied, kankaId);

        if (targetPath === file.path) {
          skipped += 1;
          occupied.add(file.path.toLowerCase());
          continue;
        }

        await this.ensureFolder(segments.join("/"));
        await this.app.vault.rename(file, targetPath);
        occupied.add(targetPath.toLowerCase());
        renamed += 1;
      }

      await this.refreshIndexesFromVault();

      const parts = [`${renamed} rinominate`];
      if (skipped) parts.push(`${skipped} senza name o già corrette`);
      new Notice(`Kanka Sync: ${parts.join(", ")}`);
    } catch (error: any) {
      console.error(error);
      new Notice(`Kanka Sync: errore rinomina — ${error?.message || error}`);
    }
  }

  private async fixAllLinks(): Promise<void> {
    try {
      const folder = this.settings.outputFolder.trim();
      if (!folder) {
        new Notice("Kanka Sync: configura la cartella di output nelle impostazioni.");
        return;
      }

      const index = await this.buildLocalEntityIndex(folder);
      if (!index.byId.size) {
        new Notice("Kanka Sync: nessuna nota con kanka_id trovata.");
        return;
      }

      const files = this.app.vault
        .getMarkdownFiles()
        .filter((file) => file.path.startsWith(folder));

      let updated = 0;
      let unchanged = 0;

      for (const file of files) {
        const original = await this.app.vault.read(file);
        const converted = this.convertReferencesWithIndex(original, index);
        if (converted === original) {
          unchanged += 1;
          continue;
        }

        await this.app.vault.modify(file, converted);
        updated += 1;
      }

      const report = [`${updated} aggiornate`];
      if (unchanged) report.push(`${unchanged} senza modifiche`);
      new Notice(`Kanka Sync: link sistemati (${report.join(", ")})`);
    } catch (error: any) {
      console.error(error);
      new Notice(`Kanka Sync: errore fix link — ${error?.message || error}`);
    }
  }

  private async refreshIndexesFromVault() {
    this.entityIndex.clear();
    this.nameIndex.clear();
    this.usedPaths.clear();

    const folder = this.settings.outputFolder.trim();
    if (!folder) return;

    const files = this.app.vault
      .getMarkdownFiles()
      .filter((file) => file.path.startsWith(folder));

    for (const file of files) {
      const cache = this.app.metadataCache.getFileCache(file);
      const rawId = cache?.frontmatter?.kanka_id ?? cache?.frontmatter?.kankaID;
      if (rawId == null) continue;
      const name = cache?.frontmatter?.name?.toString().trim() || this.extractNameFromPath(file.path);
      const entry: EntityIndexEntry = {
        id: String(rawId),
        name,
        path: normalizePath(file.path),
        type: cache?.frontmatter?.type?.toString(),
      };
      this.entityIndex.set(entry.id, entry);
      this.registerName(entry.name, entry);
      this.usedPaths.add(entry.path.toLowerCase());
    }
  }

  private async buildLocalEntityIndex(folder: string): Promise<LocalIndex> {
    const byId = new Map<string, EntityIndexEntry>();
    const byName = new Map<string, EntityIndexEntry>();

    const files = this.app.vault
      .getMarkdownFiles()
      .filter((file) => file.path.startsWith(folder));

    for (const file of files) {
      const cache = this.app.metadataCache.getFileCache(file);
      const rawId = cache?.frontmatter?.kanka_id ?? cache?.frontmatter?.kankaID;
      if (rawId == null) continue;

      const entry: EntityIndexEntry = {
        id: String(rawId),
        name: cache?.frontmatter?.name?.toString().trim() || this.extractNameFromPath(file.path),
        path: normalizePath(file.path),
        type: cache?.frontmatter?.type?.toString(),
      };

      byId.set(entry.id, entry);
      const normalized = this.normalizeName(entry.name);
      if (normalized && !byName.has(normalized)) {
        byName.set(normalized, entry);
      }
    }

    return { byId, byName };
  }

  private findRenameTarget(
    desiredPath: string,
    occupied: Set<string>,
    id?: number | string | null
  ): string {
    const desired = normalizePath(desiredPath);
    const { base, ext } = this.splitPath(desired);

    const tryCandidate = (candidate: string): string | null => {
      const normalized = normalizePath(candidate);
      if (occupied.has(normalized.toLowerCase())) return null;
      return normalized;
    };

    const direct = tryCandidate(desired);
    if (direct) return direct;

    if (id != null) {
      const withId = tryCandidate(`${base} (${id})${ext}`);
      if (withId) return withId;
    }

    let counter = 2;
    while (true) {
      const option = tryCandidate(`${base} (${counter})${ext}`);
      if (option) return option;
      counter += 1;
    }
  }

  private extractIdFromFilename(basename: string): string {
    const match = basename.match(/^([0-9]+)/);
    return match ? match[1] : basename;
  }

  private extractNameFromPath(path: string): string {
    const filename = path.split("/").pop() ?? path;
    return filename.replace(/\.md$/i, "");
  }
}

class KankaSettingsTab extends PluginSettingTab {
  plugin: KankaSyncPlugin;

  constructor(app: App, plugin: KankaSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Kanka Sync" });

    this.addTextSetting(
      "API Token",
      "Token personale Kanka (richiede permesso di lettura).",
      this.plugin.settings.apiToken,
      (value) => (this.plugin.settings.apiToken = value.trim())
    );

    this.addTextSetting(
      "Campaign ID",
      "ID numerico della campagna Kanka.",
      this.plugin.settings.campaignId,
      (value) => (this.plugin.settings.campaignId = value.trim())
    );

    this.addTextSetting(
      "Output folder",
      "Cartella base dove salvare le note scaricate.",
      this.plugin.settings.outputFolder,
      (value) => (this.plugin.settings.outputFolder = value.trim())
    );

    this.addToggleSetting(
      "Group by type",
      "Crea sottocartelle in base al tipo Kanka.",
      this.plugin.settings.groupByType,
      (value) => (this.plugin.settings.groupByType = value)
    );

    this.addToggleSetting(
      "Skip private entities",
      "Ignora le entità marcate come private.",
      this.plugin.settings.skipPrivate,
      (value) => (this.plugin.settings.skipPrivate = value)
    );

    new Setting(containerEl)
      .setName("Excluded entity types")
      .setDesc("Tipi da ignorare (separa con virgole o nuovi righi).")
      .addTextArea((area) => {
        area.inputEl.rows = 2;
        area
          .setPlaceholder("race,family")
          .setValue(this.plugin.settings.excludedTypes.join(", "))
          .onChange(async (value) => {
            this.plugin.settings.excludedTypes = value
              .split(/[\n,;]+/)
              .map((item) => item.trim())
              .filter(Boolean);
            await this.plugin.saveData(this.plugin.settings);
          });
      });

    this.addTextSetting(
      "Throttle (ms)",
      "Attesa tra le chiamate API per evitare rate limit.",
      String(this.plugin.settings.apiThrottleMs),
      (value) => {
        const numeric = Number(value);
        this.plugin.settings.apiThrottleMs = Number.isNaN(numeric) ? 0 : Math.max(0, numeric);
      }
    );

    new Setting(containerEl)
      .setName("Fix existing links")
      .setDesc("Converte le menzioni esterne (URL e [type:id]) in link Obsidian.")
      .addButton((button) =>
        button
          .setButtonText("Esegui")
          .setCta()
          .onClick(() => void this.plugin.fixAllLinks())
      );

    new Setting(containerEl)
      .setName("Rename all notes")
      .setDesc("Rinomina tutte le note usando il campo name (es. Alaster Gritch.md).")
      .addButton((button) =>
        button
          .setButtonText("Esegui")
          .onClick(() => void this.plugin.renameAllNotes())
      );
  }

  private addTextSetting(
    name: string,
    desc: string,
    value: string,
    setter: (value: string) => void
  ) {
    new Setting(this.containerEl)
      .setName(name)
      .setDesc(desc)
      .addText((text) =>
        text.setValue(value).onChange(async (newValue) => {
          setter(newValue);
          await this.plugin.saveData(this.plugin.settings);
        })
      );
  }

  private addToggleSetting(
    name: string,
    desc: string,
    value: boolean,
    setter: (value: boolean) => void
  ) {
    new Setting(this.containerEl)
      .setName(name)
      .setDesc(desc)
      .addToggle((toggle) =>
        toggle.setValue(value).onChange(async (newValue) => {
          setter(newValue);
          await this.plugin.saveData(this.plugin.settings);
        })
      );
  }
}
