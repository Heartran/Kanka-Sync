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
  path: string;
  name: string;
};

export default class KankaSyncPlugin extends Plugin {
  settings: KankaSettings;
  private entityIndex: Map<string, EntityIndexEntry> = new Map();
  private lastRequestAt = 0;
  private abortSync = false;

  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.addSettingTab(new KankaSettingsTab(this.app, this));

    this.addCommand({
      id: "kanka-sync-pull-markdown",
      name: "Download all Kanka entities (markdown)",
      callback: () => {
        void this.syncAllEntities();
      },
    });

    this.addCommand({
      id: "kanka-sync-rename-all",
      name: "Rename all Kanka notes from frontmatter",
      callback: () => {
        void this.renameAllNotes();
      },
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
      const summaries = await this.fetchAllSummaries();
      if (this.abortSync) return;

      const filtered = summaries.filter((summary) => {
        if (this.settings.skipPrivate && summary.is_private) return false;
        const type = summary.type ?? summary.entity_type ?? "";
        if (this.isTypeExcluded(type)) return false;
        return true;
      });

      filtered.forEach((summary) => {
        const entry = this.buildIndexEntry(summary);
        this.entityIndex.set(String(summary.id), entry);
      });

      let created = 0;
      let updated = 0;
      let skipped = 0;
      let failed = 0;

      for (const summary of filtered) {
        if (this.abortSync) break;
        try {
          const raw = await this.fetchMarkdown(summary.id);
          const entry = this.entityIndex.get(String(summary.id));
          if (!entry) continue;
          const content = this.prepareMarkdown(raw, summary, entry);
          const result = await this.writeEntityFile(entry.path, content);
          if (result === "created") created += 1;
          else if (result === "updated") updated += 1;
          else skipped += 1;
        } catch (error) {
          failed += 1;
          console.error("Kanka Sync: errore su entità #" + summary.id, error);
        }
      }

      if (this.abortSync) {
        new Notice("Kanka Sync: download interrotto.");
        return;
      }

      const parts = [
        `${created} create`,
        `${updated} aggiornate`,
        `${skipped} invariata`,
      ];
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

    while (true) {
      if (this.abortSync) break;
      const response = await this.apiRequest<{ data: KankaEntitySummary[]; meta?: any }>(
        `/entities?page=${page}`
      );
      const data = response?.data ?? [];
      if (!data.length) break;
      collected.push(...data);

      const pagination = response.meta?.pagination;
      if (!pagination) break;
      if (page >= pagination.total_pages) break;
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

  private prepareMarkdown(markdown: string, summary: KankaEntitySummary, entry: EntityIndexEntry) {
    const stripped = this.stripFrontmatter(markdown).trim();
    const hasHeading = stripped.startsWith("#");
    const heading = summary.name ? `# ${summary.name.trim()}` : "";
    const body = hasHeading ? stripped : [heading, stripped].filter(Boolean).join("\n\n");
    const convertedBody = this.convertReferences(body);

    const frontmatter = {
      kanka_id: summary.id,
      name: summary.name,
      type: summary.type ?? undefined,
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
      if (closing !== -1) {
        return markdown.slice(closing + 4).replace(/^\s+/, "");
      }
    }
    return markdown;
  }

  private buildIndexEntry(summary: KankaEntitySummary): EntityIndexEntry {
    const segments = this.computeFolderSegments(summary.type ?? summary.entity_type);
    const basename = this.buildBasename(summary.id, summary.name, summary.slug);
    const path = [segments.join("/"), `${basename}.md`].filter(Boolean).join("/");
    return { path, name: summary.name };
  }

  private computeFolderSegments(type?: string | null): string[] {
    const segments: string[] = [];
    const base = this.settings.outputFolder.trim();
    if (base) segments.push(base);
    if (this.settings.groupByType && type) segments.push(this.slugify(type));
    return segments;
  }

  private buildBasename(id: number | string, name: string, slug?: string | null): string {
    const slugified = slug ? this.slugify(slug) : "";
    const nameSlug = this.slugify(name);
    return `${id}-${slugified || nameSlug || "entity"}`;
  }

  private convertReferences(markdown: string): string {
    if (!markdown) return markdown;

    const campaign = this.settings.campaignId.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const basePattern = `(?:https?:\\/\\/(?:www\\.)?app\\.kanka\\.io|\\/)?\\/w\\/${campaign}\\/entities\\/(\\d+)(?:[^\\s\\)]*)?`;
    const linkRegex = new RegExp(`\\[([^\\]]+)\\]\\((?=${basePattern})[^\\)]+\\)`, "gi");
    const bareRegex = new RegExp(basePattern, "gi");

    const replaceWithLink = (entityId: string, label?: string) => {
      const entry = this.entityIndex.get(entityId);
      if (!entry) return null;
      const display = label?.trim() || entry.name || entry.path.split("/").pop() || entry.path;
      return `[[${entry.path}|${display}]]`;
    };

    const withMarkdownLinks = markdown.replace(linkRegex, (match, text) => {
      const idMatch = match.match(new RegExp(basePattern, "i"));
      if (!idMatch) return match;
      return replaceWithLink(idMatch[1], text) ?? match;
    });

    return withMarkdownLinks.replace(bareRegex, (match, entityId) => replaceWithLink(entityId) ?? match);
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

  private slugify(value: string): string {
    return value
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase();
  }

  private async throttle() {
    const wait = Math.max(0, this.settings.apiThrottleMs);
    if (wait <= 0) {
      this.lastRequestAt = Date.now();
      return;
    }

    const now = Date.now();
    const elapsed = now - this.lastRequestAt;
    if (elapsed < wait) {
      await this.delay(wait - elapsed);
    }
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

      let renamed = 0;
      let skipped = 0;

      for (const file of files) {
        const cache = this.app.metadataCache.getFileCache(file);
        const name = cache?.frontmatter?.name?.toString().trim();
        const kankaId = cache?.frontmatter?.kanka_id ?? cache?.frontmatter?.kankaID;
        const entityType = cache?.frontmatter?.type ?? cache?.frontmatter?.entity_type ?? "";
        const slug = cache?.frontmatter?.kanka_slug ?? "";

        if (!name) {
          skipped += 1;
          continue;
        }

        const segments = this.computeFolderSegments(entityType);
        const basename = this.buildBasename(
          kankaId ?? this.extractIdFromFilename(file.basename),
          name,
          slug
        );
        const targetPath = normalizePath([segments.join("/"), `${basename}.md`].filter(Boolean).join("/"));
        if (targetPath === file.path) {
          skipped += 1;
          continue;
        }

        await this.ensureFolder(segments.join("/"));
        await this.app.vault.rename(file, targetPath);
        renamed += 1;
      }

      const parts = [`${renamed} rinominate`];
      if (skipped) parts.push(`${skipped} senza name o già corrette`);
      new Notice(`Kanka Sync: ${parts.join(", ")}`);
    } catch (error: any) {
      console.error(error);
      new Notice(`Kanka Sync: errore rinomina — ${error?.message || error}`);
    }
  }

  private extractIdFromFilename(basename: string): string {
    const match = basename.match(/^([0-9]+)/);
    return match ? match[1] : basename;
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
