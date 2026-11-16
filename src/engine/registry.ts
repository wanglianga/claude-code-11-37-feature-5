import type { ModelRegistryEntry, ModelRevisionRecord, ResolvedModelRef } from '@/types/evaluation';

/** 稳定的字符串哈希（用于模型修订与样本指纹，审查时据此复核） */
export function hashString(raw: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x1000193;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = (Math.imul(h2, 31) + c) | 0;
  }
  return `${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`;
}

/** 修订哈希覆盖：基础模型、参数、规则文本与允许用途（用途变更也必须复核） */
export function revisionHash(rev: ModelRevisionRecord): string {
  return hashString(
    JSON.stringify({
      revision: rev.revision,
      baseModel: rev.baseModel,
      decayHalfLifeDays: rev.decayHalfLifeDays,
      ruleText: rev.ruleText,
      allowedUses: [...rev.allowedUses].sort(),
    }),
  );
}

export function findRevision(entry: ModelRegistryEntry, revision: string): ModelRevisionRecord | undefined {
  return entry.revisions.find((r) => r.revision === revision);
}

/** 解析登记的确定模型引用；修订不存在时返回错误 */
export function resolveModelRef(
  entry: ModelRegistryEntry,
  revision: string,
): { ok: true; ref: ResolvedModelRef } | { ok: false; error: string } {
  const rev = findRevision(entry, revision);
  if (!rev) return { ok: false, error: `模型 ${entry.registryId} 不存在修订 ${revision}` };
  return {
    ok: true,
    ref: {
      registryId: entry.registryId,
      name: entry.name,
      revision: rev.revision,
      revisionHash: revisionHash(rev),
      baseModel: rev.baseModel,
      decayHalfLifeDays: rev.decayHalfLifeDays,
      allowedUses: rev.allowedUses,
    },
  };
}

/** 登记当前修订是否仍与引用一致（发布 / 批准前复核） */
export function checkRefCurrent(
  entry: ModelRegistryEntry | undefined,
  ref: { registryId: string; revision: string; revisionHash: string },
): { ok: boolean; reason: string } {
  if (!entry) return { ok: false, reason: `模型 ${ref.registryId} 已注销或不存在` };
  if (entry.currentRevision !== ref.revision) {
    return {
      ok: false,
      reason: `模型 ${entry.name} 已从修订 ${ref.revision} 升级到 ${entry.currentRevision}，引用修订已过期，需复核`,
    };
  }
  const rev = findRevision(entry, ref.revision);
  if (!rev) return { ok: false, reason: `模型 ${entry.name} 不存在修订 ${ref.revision}` };
  const h = revisionHash(rev);
  if (h !== ref.revisionHash) {
    return { ok: false, reason: `模型 ${entry.name} 修订 ${ref.revision} 的规则/允许用途已变更，哈希不一致，需复核` };
  }
  return { ok: true, reason: '模型修订与登记一致' };
}
