import { createHash } from 'node:crypto';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { ConsoleError, type Identity } from './config';
export type Rpc = (method: string, params: any) => Promise<any>;
export interface Extension {
  id: string; kind: 'skill' | 'plugin'; name: string; label: string; description: string;
  enabled: boolean; scope?: string; pluginId?: string; marketplace?: string;
}
type ResolvedExtension = Extension & { input: { type: 'skill' | 'mention'; name: string; path: string } };
export interface Catalog { entries: ResolvedExtension[]; skillsAvailable: boolean; pluginsAvailable: boolean; issues: string[] }
const text = (v: unknown, max = 160) => typeof v === 'string' ? v.slice(0, max) : '';
const id = (kind: string, value: string) => createHash('sha256').update(kind + ':' + value).digest('hex').slice(0,32);
const list = (v: unknown): any[] => Array.isArray(v) ? v : [];

/** Only trust entries returned for this project's cwd. Browser input never selects an arbitrary file/plugin path. */
export async function readCatalog(rpc: Rpc, root: string, refresh = false): Promise<Catalog> {
  const [skillsResult, pluginsResult] = await Promise.allSettled([
    rpc('skills/list', { cwds: [root], forceReload: refresh }),
    rpc('plugin/installed', { cwds: [root] })
  ]);
  const entries = new Map<string, ResolvedExtension>();
  const issues: string[] = [];
  if (skillsResult.status === 'fulfilled') {
    for (const group of list(skillsResult.value?.data)) {
      if (typeof group?.cwd !== 'string' || (await fs.realpath(group.cwd).catch(() => '')) !== root) continue;
      if (list(group.errors).length) issues.push('部分技能加载失败');
      for (const skill of list(group.skills).slice(0,1000)) {
        if (typeof skill?.path !== 'string' || !path.isAbsolute(skill.path) || !text(skill.name)) continue;
        const key = id('skill',skill.path);
        entries.set(key, { id:key, kind:'skill', name:text(skill.name), label:text(skill.interface?.displayName || skill.name),
          description:text(skill.interface?.shortDescription || skill.shortDescription || skill.description,300),
          enabled:skill.enabled === true, scope:text(skill.scope), pluginId:text(skill.pluginId),
          input:{ type:'skill', name:skill.name, path:skill.path } });
      }
    }
  } else issues.push('此 Codex 未提供技能列表');
  if (pluginsResult.status === 'fulfilled') {
    for (const market of list(pluginsResult.value?.marketplaces).slice(0,100)) {
      for (const plugin of list(market?.plugins).slice(0,1000)) {
        if (!plugin?.installed || !text(plugin.id) || !text(plugin.name) || !text(market.name)) continue;
        // Plugin mention grammar used by Codex: plugin://<name>@<marketplace>.
        if (!/^[a-zA-Z0-9_.-]+$/.test(plugin.name) || !/^[a-zA-Z0-9_.-]+$/.test(market.name)) continue;
        const key=id('plugin',plugin.id);
        entries.set(key,{ id:key,kind:'plugin',name:plugin.name,label:text(plugin.interface?.displayName || plugin.name),
          description:text(plugin.interface?.shortDescription,300),enabled:plugin.enabled === true && !plugin.disabledReason,
          pluginId:plugin.id,marketplace:market.name,
          input:{type:'mention',name:plugin.interface?.displayName || plugin.name,path:`plugin://${plugin.name}@${market.name}`} });
      }
    }
    if (list(pluginsResult.value?.marketplaceLoadErrors).length) issues.push('部分插件目录加载失败');
  } else issues.push('此 Codex 未提供已安装插件列表');
  return {entries:[...entries.values()].slice(0,1000),skillsAvailable:skillsResult.status==='fulfilled',pluginsAvailable:pluginsResult.status==='fulfilled',issues};
}
export function publicCatalog(catalog: Catalog) {
  return {...catalog, entries:catalog.entries.map(({input, ...entry}) => entry)};
}
export function resolveExtensions(catalog: Catalog, ids: unknown) {
  if (!Array.isArray(ids) || ids.length > 12 || ids.some(key => typeof key !== 'string' || !/^[a-f0-9]{32}$/.test(key)))
    throw new ConsoleError(400,'INVALID_EXTENSIONS','最多选择 12 个技能或插件。');
  return [...new Set(ids)].map(key => {
    const entry=catalog.entries.find(e => e.id===key);
    if (!entry?.enabled) throw new ConsoleError(409,'EXTENSION_UNAVAILABLE','技能或插件已禁用、移除或不属于此项目，请刷新列表。');
    return {...entry.input};
  });
}
export function accessPolicy(identity: Identity, root: string, value: unknown, confirmed: unknown) {
  const access=value ?? 'default';
  if (!['default','read-only','full'].includes(access as string)) throw new ConsoleError(400,'INVALID_ACCESS','无效的访问权限。');
  if (access==='full') {
    if (!identity.elevated) throw new ConsoleError(403,'ADMIN_REQUIRED','完全访问权限仅限管理员。');
    if (confirmed !== true) throw new ConsoleError(400,'ACCESS_CONFIRMATION_REQUIRED','请先确认完全访问权限。');
    return {approvalPolicy:'never',sandboxPolicy:{type:'dangerFullAccess'}};
  }
  if (access==='read-only') return {approvalPolicy:'never',sandboxPolicy:{type:'readOnly',networkAccess:false}};
  return {approvalPolicy:'on-request',sandboxPolicy:{type:'workspaceWrite',writableRoots:[root],networkAccess:false,excludeTmpdirEnvVar:true,excludeSlashTmp:true}};
}
export async function readMcp(rpc: Rpc, threadId?: string) {
  const result=await rpc('mcpServerStatus/list',{limit:100,detail:'toolsAndAuthOnly',...(threadId?{threadId}:{})});
  return {data:list(result?.data).slice(0,100).map(s=>({name:text(s.name),authStatus:text(s.authStatus),runtimeStatus:text(typeof s.runtimeStatus==='string'?s.runtimeStatus:s.runtimeStatus?.type),tools:Object.keys(s.tools||{}).slice(0,200).map(v=>text(v)),pluginId:text(s.pluginId)})),more:Boolean(result?.nextCursor)};
}
