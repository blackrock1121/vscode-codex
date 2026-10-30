import { errorFields, expectedFileError, operationFailure, operationLog } from './operations';
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

const DAY = 86400000;
const RETRY = 3600000;
const MAX_CACHE_AGE = 7 * DAY;
export const DEFAULT_QUIET_HOURS = { enabled: false, start: "08:30", end: "18:00" };
export interface QuietHours { enabled: boolean; start: string; end: string }
interface HolidayYear {
    year: number;
    papers: string[];
    days: { date: string; name: string; isOffDay: boolean }[];
}
interface CachedYear { fetchedAt: number; data: HolidayYear }

export function parseQuietHours(value: unknown): QuietHours | undefined {
    if (!value || typeof value !== "object") return undefined;
    const v = value as QuietHours;
    const time = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
    if (typeof v.enabled !== "boolean" || typeof v.start !== "string" || typeof v.end !== "string" ||
        !time.test(v.start) || !time.test(v.end) || v.start >= v.end) return undefined;
    return { enabled: v.enabled, start: v.start, end: v.end };
}

export function isFeishuWebhook(url: string): boolean {
    try { return ["open.feishu.cn", "open.larksuite.com"].includes(new URL(url).hostname); }
    catch { return false; }
}

/** 固定北京时间，远程连接或扩展宿主时区变化不能改变静默时段。 */
export function chinaDate(now: Date) {
    const local = new Date(now.getTime() + 8 * 3600000);
    return { date: local.toISOString().slice(0, 10), time: local.toISOString().slice(11, 16),
        year: local.getUTCFullYear(), month: local.getUTCMonth() + 1, weekday: local.getUTCDay() };
}

export function parseHolidayYear(value: unknown, year: number): HolidayYear {
    const v = value as HolidayYear | undefined;
    if (!v || v.year !== year || !Array.isArray(v.papers) || !Array.isArray(v.days) || v.days.length > 400 ||
        !v.papers.every(p => {
            try { const u = new URL(p); return u.protocol === "https:" && (u.hostname === "www.gov.cn" || u.hostname.endsWith(".gov.cn")); }
            catch { return false; }
        })) throw new Error(`${year} 年日历格式无效`);
    const seen = new Set<string>();
    for (const day of v.days) {
        if (!day || typeof day.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day.date) ||
            !Number.isFinite(Date.parse(day.date)) || new Date(day.date).toISOString().slice(0, 10) !== day.date ||
            Math.abs(Number(day.date.slice(0, 4)) - year) > 1 || seen.has(day.date) ||
            typeof day.isOffDay !== "boolean" || typeof day.name !== "string" || !day.name.trim()) {
            throw new Error(`${year} 年日历日期无效`);
        }
        seen.add(day.date);
    }
    if (!!v.papers.length !== !!v.days.length) throw new Error(`${year} 年日历不完整`);
    return { year, papers: v.papers, days: v.days };
}

/** 只下载公开年度日历，不发送任务内容。无有效数据时返回未知，调用方继续推送。 */
export class WorkdayCalendar {
    private readonly cache = new Map<number, CachedYear>();
    private readonly loaded = new Set<number>();
    private readonly attempts = new Map<number, number>();
    private readonly errors = new Map<number, string>();
    private active?: Promise<void>;
    private timer?: ReturnType<typeof setInterval>;
    private abort?: AbortController;
    private disposed = false;
    constructor(private readonly directory: string, private readonly log: (message: string) => void,
                private readonly changed: () => void = () => {}, private readonly fetcher: typeof fetch = fetch) {}

    configure(enabled: boolean): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = undefined;
        if (!enabled || this.disposed) {
            this.abort?.abort();
            return;
        }
        void this.refresh();
        // 每小时检查到期/失败重试；成功后同一年度 24 小时内不重复联网。
        this.timer = setInterval(() => { void this.refresh(); }, RETRY);
        this.timer.unref();
    }

    refresh(force = false, now = new Date()): Promise<void> {
        if (this.disposed) return Promise.resolve();
        if (this.active) return this.active;
        this.abort = new AbortController();
        const year = chinaDate(now).year;
        this.active = Promise.all([year, year + 1].map(y => this.updateYear(y, force, now.getTime(), this.abort!.signal)))
            .then(() => { if (!this.disposed) this.changed(); })
            .catch(error => operationFailure('calendar.refresh', error))
            .finally(() => { this.active = undefined; });
        return this.active;
    }

    private async updateYear(year: number, force: boolean, now: number, signal: AbortSignal): Promise<void> {
        if (!this.loaded.has(year)) {
            this.loaded.add(year);
            try {
                const raw = JSON.parse(await fs.readFile(path.join(this.directory, `${year}.json`), "utf8")) as CachedYear;
                if (Number.isFinite(raw.fetchedAt) && raw.fetchedAt <= now && raw.fetchedAt > 0)
                    this.cache.set(year, { fetchedAt: raw.fetchedAt, data: parseHolidayYear(raw.data, year) });
            } catch (error) { if (!expectedFileError(error)) operationFailure('calendar.cache.read', error, { year }); }
        }
        const cached = this.cache.get(year), attempted = this.attempts.get(year);
        if (!force && ((cached && now >= cached.fetchedAt && now - cached.fetchedAt < DAY) ||
            (attempted !== undefined && now >= attempted && now - attempted < RETRY))) return;
        if (signal.aborted) return;
        this.attempts.set(year, now);
        const operationId = randomUUID(), started = performance.now();
        operationLog('calendar.update', 'start', { operationId, year });
        try {
            let data: HolidayYear | undefined;
            let lastError: unknown;
            for (const base of ["https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/", "https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/"]) {
                if (signal.aborted) { operationLog('calendar.update', 'cancelled', { operationId, year }); return; }
                const controller = new AbortController();
                const cancel = () => controller.abort();
                signal.addEventListener("abort", cancel, { once: true });
                const timeout = setTimeout(cancel, 8000);
                try {
                    const response = await this.fetcher(`${base}${year}.json`, { signal: controller.signal, headers: { Accept: "application/json" } });
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                    const body = await response.text();
                    if (body.length > 256000) throw new Error("日历数据超出大小限制");
                    data = parseHolidayYear(JSON.parse(body), year);
                    break;
                } catch (error) { lastError = error; }
                finally { clearTimeout(timeout); signal.removeEventListener("abort", cancel); }
            }
            if (!data) throw lastError ?? new Error("日历下载失败");
            if (signal.aborted) { operationLog('calendar.update', 'cancelled', { operationId, year }); return; }
            const record = { fetchedAt: now, data };
            this.cache.set(year, record);
            if (this.errors.has(year)) operationLog('calendar.update', 'recovered', { operationId, year, previousFailureId: this.errors.get(year) });
            this.errors.delete(year);
            const temp = path.join(this.directory, `${year}-${randomUUID()}.tmp`);
            try {
                await fs.mkdir(this.directory, { recursive: true });
                await fs.writeFile(temp, JSON.stringify(record));
                await fs.rename(temp, path.join(this.directory, `${year}.json`));
            } catch (error) { operationFailure('calendar.cache.write', error, { operationId, year }); }
            finally { await fs.rm(temp, { force: true }).catch(error => { if (!expectedFileError(error)) operationFailure('calendar.cleanup', error, { year }); }); }
            this.log(`[calendar] ${year} 年日历${data.days.length ? "已更新（含节假日与调休）" : "尚未公布"}`);
            operationLog('calendar.update', 'completed', { operationId, year, durationMs: Math.round(performance.now() - started) });
        } catch (error) {
            if (signal.aborted) { operationLog('calendar.update', 'cancelled', { operationId, year }); return; }
            operationFailure('calendar.update', error, { operationId, year, fallback: this.usable(year, now) ? 'cached' : 'unavailable',
                durationMs: Math.round(performance.now() - started) });
            this.errors.set(year, String(errorFields(error).failureId ?? operationId));
            this.log(`[calendar] ${year} 年更新失败，使用七天内有效缓存；无有效缓存时不静默`);
        }
    }

    private usable(year: number, now: number): CachedYear | undefined {
        const c = this.cache.get(year);
        return c && c.data.papers.length && c.data.days.length && now >= c.fetchedAt && now - c.fetchedAt < MAX_CACHE_AGE ? c : undefined;
    }

    isWorkday(now = new Date()): boolean | undefined {
        const today = chinaDate(now), current = this.usable(today.year, now.getTime());
        if (!current) return undefined;
        // 次年元旦安排可能修改本年 12 月日期，不能仅按星期或本年文件推断。
        const next = this.usable(today.year + 1, now.getTime());
        if (today.month === 12 && !next) return undefined;
        const exception = (next?.data.days.find(d => d.date === today.date) ?? current.data.days.find(d => d.date === today.date));
        return exception ? !exception.isOffDay : today.weekday !== 0 && today.weekday !== 6;
    }

    shouldMute(value: unknown, now = new Date()): boolean {
        const hours = parseQuietHours(value);
        if (!hours?.enabled) return false;
        const time = chinaDate(now).time;
        return time >= hours.start && time < hours.end && this.isWorkday(now) === true;
    }

    status(now = new Date()): string {
        const today = chinaDate(now), record = this.usable(today.year, now.getTime());
        if (!record) return `${today.year} 年暂无有效日历，飞书照常推送。开启后自动联网更新，也可手动刷新。`;
        const updated = chinaDate(new Date(record.fetchedAt));
        const nextMissing = today.month === 12 && !this.usable(today.year + 1, now.getTime());
        return `${today.year} 年日历已同步，更新于 ${updated.date} ${updated.time}（北京时间）。` +
            (this.errors.has(today.year) ? "最近联网失败，暂用七天内缓存。" : "") +
            (nextMissing ? "次年安排尚未同步，12 月暂不静默。" : "");
    }

    dispose(): void {
        this.disposed = true;
        if (this.timer) clearInterval(this.timer);
        this.abort?.abort();
    }
}
