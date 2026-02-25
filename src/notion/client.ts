import {
	type NotionPage,
	type QueueTask,
	richTextFromPage,
	rt,
	statusFromPage,
	titleFromPage,
} from "./types.js";

export type TaskRow = {
	pageId: string;
	name: string;
	status: string | null;
	sessionKey: string;
	currentAction: string;
};

export type StaleTaskRow = {
	pageId: string;
	name: string;
	status: string;
};

export type NotionComment = {
	id: string;
	createdTime: string;
	createdByType: string;
	createdByName: string;
	text: string;
};

const SYSTEM_SECTION_PREFIXES = [
	"Plan",
	"Build + Verify",
	"Done",
	"User Comment Received",
	"Error",
];

const STATUS_EMOJI: Record<string, string> = {
	done: "✅",
	plan: "📝",
	build: "👷‍♀️",
	blocked: "❗",
};

const KNOWN_STATUS_PREFIXES = Object.values(STATUS_EMOJI)
	.map((emoji) => emoji.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
	.join("|");

const STATUS_PREFIX_RE = new RegExp(`^(?:${KNOWN_STATUS_PREFIXES})\\s+`, "u");

function stripStatusPrefix(title: string): string {
	return title.replace(STATUS_PREFIX_RE, "").trim();
}

// status emoji now lives only in Notion page icon (not title)

function statusEmojiFor(status: string | null): string | undefined {
	return status ? STATUS_EMOJI[status.toLowerCase()] : undefined;
}

type NotionBlock = {
	object: "block";
	type: "heading_3" | "paragraph" | "code";
	heading_3?: any;
	paragraph?: any;
	code?: any;
};

type NotionPageIcon = { type: "emoji"; emoji: string } | null;

const NOTION_VERSION = "2025-09-03";

type NotionConfig = {
	apiKey: string;
	dataSourceId: string;
	maxRetries?: number;
};

const PROP_ALIASES: Record<string, string[]> = {
	name: ["name", "Name"],
	status: ["status", "Status"],
	ready_to_build: ["ready to build", "Ready to build", "ready_to_build"],
	session_key: ["session key", "Session key", "session_key"],
	claim_token: ["claim token", "Claim token", "claim_token"],
	claimed_at: ["claimed at", "Claimed at", "claimed_at"],
	last_update_at: ["last update at", "Last update at", "last_update_at"],
	current_action: ["current action", "Current action", "current_action"],
};

const REQUIRED_PROPS = [
	"name",
	"status",
	"ready_to_build",
	"session_key",
	"claim_token",
	"claimed_at",
	"last_update_at",
	"current_action",
] as const;

const PROP_ALLOWED_TYPES: Partial<Record<keyof typeof PROP_ALIASES, string[]>> =
	{
		name: ["title"],
		status: ["status", "select"],
		ready_to_build: ["checkbox"],
		session_key: ["rich_text"],
		claim_token: ["rich_text"],
		claimed_at: ["date"],
		last_update_at: ["date"],
		current_action: ["rich_text"],
	};

// legacy optional fields removed by design

function normalizePropName(name: string): string {
	return name.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

export class NotionClient {
	private maxRetries: number;
	private propMap: Record<string, string> | null = null;
	private propTypeMap: Record<string, string> | null = null;

	constructor(private cfg: NotionConfig) {
		this.maxRetries = cfg.maxRetries ?? 3;
	}

	private async ensurePropMap() {
		if (this.propMap) return;

		const data = await this.request(
			`/v1/data_sources/${this.cfg.dataSourceId}`,
			{ method: "GET" },
		);
		const availableProps = data?.properties ?? {};
		const availableNames = Object.keys(availableProps);
		const normalizedToActual = new Map<string, string>();

		for (const name of availableNames) {
			const normalized = normalizePropName(name);
			if (!normalizedToActual.has(normalized)) {
				normalizedToActual.set(normalized, name);
			}
		}

		this.propMap = {};
		this.propTypeMap = {};
		const missing: string[] = [];

		for (const [logical, aliases] of Object.entries(PROP_ALIASES)) {
			let resolved: string | undefined;
			const allowedTypes =
				PROP_ALLOWED_TYPES[logical as keyof typeof PROP_ALIASES] ?? [];

			for (const alias of aliases) {
				const candidates: string[] = [];
				if (availableNames.includes(alias)) candidates.push(alias);

				const normalizedAlias = normalizePropName(alias);
				const match = normalizedToActual.get(normalizedAlias);
				if (match && !candidates.includes(match)) candidates.push(match);

				for (const candidate of candidates) {
					const propType = availableProps[candidate]?.type;
					if (allowedTypes.length > 0 && !allowedTypes.includes(propType)) {
						continue;
					}
					resolved = candidate;
					break;
				}

				if (resolved) break;
			}

			if (!resolved) {
				missing.push(`${logical} (aliases: ${aliases.join(" | ")})`);
				continue;
			}

			this.propMap[logical] = resolved;
			this.propTypeMap[logical] = availableProps[resolved]?.type ?? "unknown";
		}

		if (missing.length > 0) {
			throw new Error(
				`Notion schema mismatch. Missing required properties: ${missing.join(", ")}. Available properties: ${availableNames.join(", ")}`,
			);
		}

		for (const logical of REQUIRED_PROPS) {
			if (!this.propMap[logical]) {
				throw new Error(
					`Notion schema mismatch. Could not resolve property mapping for: ${logical}`,
				);
			}
		}
	}

	private async p(logical: keyof typeof PROP_ALIASES) {
		await this.ensurePropMap();
		const resolved = this.propMap?.[logical];
		if (!resolved) {
			throw new Error(
				`Notion schema mismatch. Could not resolve required property mapping for: ${logical}`,
			);
		}
		return resolved;
	}

	private async propType(logical: keyof typeof PROP_ALIASES) {
		await this.ensurePropMap();
		return this.propTypeMap?.[logical] ?? "unknown";
	}

	private async statusFilterCondition(status: string) {
		const statusProp = await this.p("status");
		const statusType = await this.propType("status");
		const key = statusType === "select" ? "select" : "status";
		return {
			property: statusProp,
			[key]: { equals: status },
		} as Record<string, unknown>;
	}

	private async statusPropertyValue(status: string) {
		const statusType = await this.propType("status");
		return statusType === "select"
			? { select: { name: status } }
			: { status: { name: status } };
	}

	// no optional property lookups: schema is status + current action driven

	private dateFromPage(page: any, prop: string): string | null {
		return page?.properties?.[prop]?.date?.start ?? null;
	}

	private headers() {
		return {
			Authorization: `Bearer ${this.cfg.apiKey}`,
			"Notion-Version": NOTION_VERSION,
			"Content-Type": "application/json",
		};
	}

	private async request(
		path: string,
		init: RequestInit,
		attempt = 1,
	): Promise<any> {
		const res = await fetch(`https://api.notion.com${path}`, {
			...init,
			headers: {
				...this.headers(),
				...(init.headers ?? {}),
			},
		});

		if (res.ok) return res.json();

		const shouldRetry = res.status === 429 || res.status >= 500;
		if (shouldRetry && attempt < this.maxRetries) {
			const waitMs = Math.min(3000, 250 * 2 ** attempt);
			await new Promise((r) => setTimeout(r, waitMs));
			return this.request(path, init, attempt + 1);
		}

		throw new Error(
			`${init.method ?? "GET"} ${path} failed: ${res.status} ${await res.text()}`,
		);
	}

	async queryTasksByStatus(
		status: string,
		pageSize = 20,
	): Promise<QueueTask[]> {
		const statusProp = await this.p("status");
		const nameProp = await this.p("name");
		const statusFilter = await this.statusFilterCondition(status);

		const data = await this.request(
			`/v1/data_sources/${this.cfg.dataSourceId}/query`,
			{
				method: "POST",
				body: JSON.stringify({
					page_size: pageSize,
					filter: statusFilter,
				}),
			},
		);

		return (data.results ?? []).map((row: any) => ({
			pageId: row.id,
			name: titleFromPage(row, nameProp),
			status: statusFromPage(row, statusProp),
		}));
	}

	async queryPickableQueueTasks(pageSize = 20): Promise<QueueTask[]> {
		const statusProp = await this.p("status");
		const readyProp = await this.p("ready_to_build");
		const nameProp = await this.p("name");
		const queueFilter = await this.statusFilterCondition("queue");

		const data = await this.request(
			`/v1/data_sources/${this.cfg.dataSourceId}/query`,
			{
				method: "POST",
				body: JSON.stringify({
					page_size: pageSize,
					filter: {
						and: [
							queueFilter,
							{
								property: readyProp,
								checkbox: { equals: true },
							},
						],
					},
				}),
			},
		);

		return (data.results ?? []).map((row: any) => ({
			pageId: row.id,
			name: titleFromPage(row, nameProp),
			status: statusFromPage(row, statusProp),
		}));
	}

	async queryStaleTasksByStatuses(
		statuses: string[],
		staleBeforeIso: string,
		pageSize = 20,
	): Promise<StaleTaskRow[]> {
		const sanitizedStatuses = statuses
			.map((s) => s.trim())
			.filter((s) => s.length > 0)
			.map((s) => s.toLowerCase());

		if (sanitizedStatuses.length === 0) return [];

		const statusProp = await this.p("status");
		const nameProp = await this.p("name");
		const lastUpdateAtProp = await this.p("last_update_at");
		const statusFilters = await Promise.all(
			sanitizedStatuses.map((status) => this.statusFilterCondition(status)),
		);

		const data = await this.request(
			`/v1/data_sources/${this.cfg.dataSourceId}/query`,
			{
				method: "POST",
				body: JSON.stringify({
					page_size: pageSize,
					filter: {
						and: [
							{
								or: statusFilters,
							},
							{
								property: lastUpdateAtProp,
								date: { before: staleBeforeIso },
							},
						],
					},
				}),
			},
		);

		return (data.results ?? []).map((row: any) => ({
			pageId: row.id,
			name: titleFromPage(row, nameProp),
			status: statusFromPage(row, statusProp) ?? "unknown",
		}));
	}

	async recoverStaleTaskToQueue(
		pageId: string,
		currentStatus: string,
		reason: string,
	) {
		const statusProp = await this.p("status");
		const claimTokenProp = await this.p("claim_token");
		const claimedAtProp = await this.p("claimed_at");
		const sessionKeyProp = await this.p("session_key");
		const currentActionProp = await this.p("current_action");
		const lastUpdateAtProp = await this.p("last_update_at");

		const decorated = await this.applyStatusDecorations(pageId, "queue", {
			[statusProp]: await this.statusPropertyValue("queue"),
			[claimTokenProp]: rt(""),
			[claimedAtProp]: { date: null },
			[sessionKeyProp]: rt(""),
			[currentActionProp]: rt(reason.slice(0, 500)),
			[lastUpdateAtProp]: { date: { start: new Date().toISOString() } },
		});

		await this.patchPage(pageId, decorated.properties, decorated.icon);

		const current = await this.getPage(pageId);
		const status = statusFromPage(current, statusProp);
		const recovered = status === "queue";

		return {
			recovered,
			previousStatus: currentStatus,
			currentStatus: status,
		};
	}

	async queryTasksForCommentWatch(pageSize = 100): Promise<TaskRow[]> {
		const statusProp = await this.p("status");
		const nameProp = await this.p("name");
		const sessionKeyProp = await this.p("session_key");
		const currentActionProp = await this.p("current_action");

		const data = await this.request(
			`/v1/data_sources/${this.cfg.dataSourceId}/query`,
			{
				method: "POST",
				body: JSON.stringify({ page_size: pageSize }),
			},
		);

		const rows: TaskRow[] = (data.results ?? []).map((row: any) => ({
			pageId: row.id,
			name: titleFromPage(row, nameProp),
			status: statusFromPage(row, statusProp),
			sessionKey: richTextFromPage(row, sessionKeyProp),
			currentAction: richTextFromPage(row, currentActionProp),
		}));

		return rows.filter((r) => r.status === "blocked" && Boolean(r.sessionKey));
	}

	async getPage(pageId: string): Promise<NotionPage> {
		return this.request(`/v1/pages/${pageId}`, { method: "GET" });
	}

	async patchPage(
		pageId: string,
		properties: Record<string, unknown>,
		icon?: NotionPageIcon,
	) {
		const body: Record<string, unknown> = { properties };
		if (icon !== undefined) body.icon = icon;

		return this.request(`/v1/pages/${pageId}`, {
			method: "PATCH",
			body: JSON.stringify(body),
		});
	}

	private async applyStatusDecorations(
		pageId: string,
		status: string,
		properties: Record<string, unknown>,
	) {
		const nameProp = await this.p("name");
		const page = await this.getPage(pageId);
		const currentTitle = titleFromPage(page, nameProp);
		const cleanedTitle = stripStatusPrefix(currentTitle);
		const emoji = statusEmojiFor(status);

		return {
			properties: {
				...properties,
				...(cleanedTitle !== currentTitle
					? {
							[nameProp]: {
								title: [
									{
										type: "text",
										text: { content: cleanedTitle.slice(0, 2000) },
									},
								],
							},
						}
					: {}),
			},
			icon: emoji ? ({ type: "emoji", emoji } as const) : null,
		};
	}

	async claimQueueTask(pageId: string, claimToken: string, nowIso: string) {
		const statusProp = await this.p("status");
		const claimTokenProp = await this.p("claim_token");
		const claimedAtProp = await this.p("claimed_at");
		const lastUpdateAtProp = await this.p("last_update_at");
		const currentActionProp = await this.p("current_action");

		const decorated = await this.applyStatusDecorations(pageId, "plan", {
			[statusProp]: await this.statusPropertyValue("plan"),
			[claimTokenProp]: rt(claimToken),
			[claimedAtProp]: { date: { start: nowIso } },
			[lastUpdateAtProp]: { date: { start: nowIso } },
			[currentActionProp]: rt("Claimed by picker; creating worker session"),
		});

		await this.patchPage(pageId, decorated.properties, decorated.icon);

		const current = await this.getPage(pageId);
		const currentToken = richTextFromPage(current, claimTokenProp);
		const currentStatus = statusFromPage(current, statusProp);

		return {
			claimed: currentToken === claimToken && currentStatus === "plan",
			currentToken,
			currentStatus,
		};
	}

	async setSessionKey(
		pageId: string,
		sessionKey: string,
		currentAction?: string,
	) {
		const sessionKeyProp = await this.p("session_key");
		const currentActionProp = await this.p("current_action");
		const lastUpdateAtProp = await this.p("last_update_at");

		await this.patchPage(pageId, {
			[sessionKeyProp]: rt(sessionKey),
			...(currentAction ? { [currentActionProp]: rt(currentAction) } : {}),
			[lastUpdateAtProp]: { date: { start: new Date().toISOString() } },
		});
	}

	async markTaskPlanStarted(pageId: string, currentAction: string) {
		const statusProp = await this.p("status");
		const currentActionProp = await this.p("current_action");
		const lastUpdateAtProp = await this.p("last_update_at");

		const decorated = await this.applyStatusDecorations(pageId, "plan", {
			[statusProp]: await this.statusPropertyValue("plan"),
			[currentActionProp]: rt(currentAction),
			[lastUpdateAtProp]: { date: { start: new Date().toISOString() } },
		});

		await this.patchPage(pageId, decorated.properties, decorated.icon);
	}

	async markTaskBuildStarted(pageId: string, currentAction: string) {
		const statusProp = await this.p("status");
		const currentActionProp = await this.p("current_action");
		const lastUpdateAtProp = await this.p("last_update_at");

		const decorated = await this.applyStatusDecorations(pageId, "build", {
			[statusProp]: await this.statusPropertyValue("build"),
			[currentActionProp]: rt(currentAction),
			[lastUpdateAtProp]: { date: { start: new Date().toISOString() } },
		});

		await this.patchPage(pageId, decorated.properties, decorated.icon);
	}

	async markTaskDone(pageId: string, currentAction: string) {
		const statusProp = await this.p("status");
		const currentActionProp = await this.p("current_action");
		const lastUpdateAtProp = await this.p("last_update_at");

		const decorated = await this.applyStatusDecorations(pageId, "done", {
			[statusProp]: await this.statusPropertyValue("done"),
			[currentActionProp]: rt(currentAction),
			[lastUpdateAtProp]: { date: { start: new Date().toISOString() } },
		});

		await this.patchPage(pageId, decorated.properties, decorated.icon);
	}

	async markTaskBlocked(
		pageId: string,
		reason: string,
		currentAction = "Task blocked",
	) {
		const statusProp = await this.p("status");
		const currentActionProp = await this.p("current_action");
		const lastUpdateAtProp = await this.p("last_update_at");

		const decorated = await this.applyStatusDecorations(pageId, "blocked", {
			[statusProp]: await this.statusPropertyValue("blocked"),
			[currentActionProp]: rt(`${currentAction}: ${reason}`.slice(0, 500)),
			[lastUpdateAtProp]: { date: { start: new Date().toISOString() } },
		});

		await this.patchPage(pageId, decorated.properties, decorated.icon);
	}

	private blockPlainText(block: any): string {
		const type = block?.type;
		if (!type) return "";
		const payload = block[type] ?? {};
		const rich = payload.rich_text ?? [];
		return rich
			.map((x: any) => x?.plain_text ?? "")
			.join("")
			.trim();
	}

	async listPageBlocks(pageId: string): Promise<any[]> {
		const out: any[] = [];
		let cursor: string | undefined;

		while (true) {
			const qs = new URLSearchParams();
			if (cursor) qs.set("start_cursor", cursor);
			const path = `/v1/blocks/${pageId}/children${qs.size ? `?${qs.toString()}` : ""}`;
			const data = await this.request(path, { method: "GET" });

			out.push(...(data.results ?? []));
			if (!data.has_more || !data.next_cursor) break;
			cursor = data.next_cursor;
		}

		return out;
	}

	async getTaskContextFromPage(
		pageId: string,
		maxChars = 6000,
	): Promise<string> {
		const blocks = await this.listPageBlocks(pageId);
		const lines: string[] = [];

		for (const b of blocks) {
			const type = b?.type;
			const text = this.blockPlainText(b);
			if (!text) continue;

			if (type === "heading_3") {
				const isSystem = SYSTEM_SECTION_PREFIXES.some((prefix) =>
					text.startsWith(prefix),
				);
				if (isSystem) break;
			}

			if (type === "bulleted_list_item") lines.push(`- ${text}`);
			else if (type === "numbered_list_item") lines.push(`1. ${text}`);
			else if (type === "to_do") lines.push(`- [ ] ${text}`);
			else if (type === "code") lines.push(`\n\`\`\`\n${text}\n\`\`\`\n`);
			else lines.push(text);

			const joined = lines.join("\n");
			if (joined.length >= maxChars) return joined.slice(0, maxChars);
		}

		return lines.join("\n").slice(0, maxChars);
	}

	async listComments(pageId: string): Promise<NotionComment[]> {
		const data = await this.request(
			`/v1/comments?block_id=${encodeURIComponent(pageId)}`,
			{
				method: "GET",
			},
		);

		return (data.results ?? []).map((c: any) => ({
			id: c.id,
			createdTime: c.created_time,
			createdByType: c?.created_by?.type ?? "unknown",
			createdByName: c?.created_by?.name ?? "unknown",
			text: (c.rich_text ?? [])
				.map((x: any) => x?.plain_text ?? "")
				.join("")
				.trim(),
		}));
	}

	async appendProgressSection(
		pageId: string,
		heading: string,
		content: string,
	) {
		const children: NotionBlock[] = [
			{
				object: "block",
				type: "heading_3",
				heading_3: {
					rich_text: [
						{ type: "text", text: { content: heading.slice(0, 200) } },
					],
				},
			},
		];

		const chunks = content.match(/[\s\S]{1,1800}/g) ?? [""];
		for (const chunk of chunks) {
			children.push({
				object: "block",
				type: "paragraph",
				paragraph: {
					rich_text: [{ type: "text", text: { content: chunk } }],
				},
			});
		}

		await this.request(`/v1/blocks/${pageId}/children`, {
			method: "PATCH",
			body: JSON.stringify({ children }),
		});
	}

	async createDatabase(
		parentPageId: string,
		title: string,
		workflowId?: string,
	): Promise<string> {
		const dbTitle = `NotionFlow: ${title}`;
		const schemaProperties = {
			Name: { title: {} },
			Status: {
				select: {
					options: [
						{ name: "queue", color: "gray" },
						{ name: "plan", color: "yellow" },
						{ name: "build", color: "blue" },
						{ name: "blocked", color: "red" },
						{ name: "done", color: "green" },
					],
				},
			},
			"Ready to build": { checkbox: {} },
			"Session key": { rich_text: {} },
			"Claim token": { rich_text: {} },
			"Claimed at": { date: {} },
			"Last update at": { date: {} },
			"Current action": { rich_text: {} },
		};

		// 2025-09-03 API: databases + data sources are separate concepts.
		// POST /v1/databases accepts initial_data_source for properties.
		// Status type cannot be created via API — use select instead.
		const body = {
			parent: { type: "page_id" as const, page_id: parentPageId },
			title: [{ type: "text" as const, text: { content: dbTitle } }],
			initial_data_source: {
				properties: schemaProperties,
			},
		};

		const data = await this.request("/v1/databases", {
			method: "POST",
			body: JSON.stringify(body),
		});

		// The response includes data_sources array with the auto-created data source
		const dataSources = data?.data_sources ?? [];
		if (dataSources.length > 0) {
			return dataSources[0].id;
		}

		// Fallback: fetch the database to get data_source ID
		const dbDetail = await this.request(`/v1/databases/${data.id}`, {
			method: "GET",
		});
		const dsList = dbDetail?.data_sources ?? [];
		if (dsList.length > 0) {
			return dsList[0].id;
		}
		return data.id;
	}

	async appendMarkdownSection(
		pageId: string,
		heading: string,
		markdown: string,
	) {
		const timestamp =
			new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";
		const children: NotionBlock[] = [
			{
				object: "block",
				type: "heading_3",
				heading_3: {
					rich_text: [
						{
							type: "text",
							text: { content: `${heading} · ${timestamp}`.slice(0, 200) },
						},
					],
				},
			},
		];

		const chunks = (markdown || "").match(/[\s\S]{1,1800}/g) ?? [""];
		for (const chunk of chunks) {
			children.push({
				object: "block",
				type: "code",
				code: {
					caption: [],
					language: "markdown",
					rich_text: [{ type: "text", text: { content: chunk } }],
				},
			});
		}

		await this.request(`/v1/blocks/${pageId}/children`, {
			method: "PATCH",
			body: JSON.stringify({ children }),
		});
	}
}
