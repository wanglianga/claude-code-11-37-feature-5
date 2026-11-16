import type {
  Channel,
  DataSnapshot,
  IdentityLink,
  IngestionJob,
  Order,
  OrderVersion,
  PlatformClickAggregate,
  RefundEvent,
  Touchpoint,
} from '@/types/domain';
import type { ModelRegistryEntry, SampleDefinition, SupplementBatch } from '@/types/evaluation';

// ============================================================
// 样例数据
// 金额单位：分。场景标签直接写在订单 scenarioTag 上，便于验收回查。
// 快照：
//   DS-2026-11-01（DV-2026.11.01）—— 首次接入（归因运行可用）
//   DS-2026-11-05（DV-2026.11.05）—— 迟到退款 R-1006 到达后的新版本
//   DS-2026-11-15（DV-2026.11.15）—— 近期窗口 + 评估群体（漂移监测 / 评估样本）
// 归因运行仍只消费前两个快照；评估样本按「窗口 + 退款截止点」自行圈定订单。
// ============================================================

export const RULE_REVISION_V1 = 'RR-2026-03';
export const RULE_REVISION_V2 = 'RR-2026-04';
export const RULE_REVISION_V3 = 'RR-2026-05';

/** 评估的声明式「当前时间」：成熟判定只看这个值，不依赖墙上时钟 */
export const EVAL_AS_OF = '2026-11-16T12:00:00Z';

export const channels: Channel[] = [
  { channelId: 'C-SEM', name: '品牌搜索', platform: 'Google Ads', mediaType: '搜索' },
  { channelId: 'C-SOCIAL', name: '社交流', platform: 'Meta', mediaType: '社交' },
  { channelId: 'C-DISPLAY', name: '展示广告', platform: 'The Trade Desk', mediaType: '展示' },
  { channelId: 'C-EMAIL', name: 'EDM 邮件', platform: '自有营销云', mediaType: '邮件' },
  { channelId: 'C-ORGANIC', name: '自然流量', platform: '自有', mediaType: '自有' },
  { channelId: 'C-AFFILIATE', name: '联盟流量', platform: '联盟网络', mediaType: '展示' },
];

function personLink(personId: string, displayName: string, deviceId: string, authorized: boolean, note?: string): IdentityLink {
  return {
    personId,
    displayName,
    crossDeviceAuthorized: authorized,
    identifiers: [
      { kind: 'login_id', value: `login-${personId.slice(-4)}`, authorized: true, deviceId },
      { kind: 'device_id', value: deviceId, authorized: true, deviceId },
    ],
    ...(note ? { note } : {}),
  };
}

export const identityLinks: IdentityLink[] = [
  {
    personId: 'P-1001',
    displayName: '李雷（已授权跨设备）',
    crossDeviceAuthorized: true,
    identifiers: [
      { kind: 'login_id', value: 'login-1001', authorized: true, deviceId: 'D-A1' },
      { kind: 'login_id', value: 'login-1001', authorized: true, deviceId: 'D-A2' },
      { kind: 'email_hash', value: 'hash-aa77', authorized: true, deviceId: 'D-A1' },
      { kind: 'device_id', value: 'D-A1', authorized: true, deviceId: 'D-A1' },
      { kind: 'device_id', value: 'D-A2', authorized: true, deviceId: 'D-A2' },
    ],
    note: '登录 ID 在两台设备均完成授权同意，允许跨设备连接旅程。',
  },
  {
    personId: 'P-1002',
    displayName: '韩梅梅（单设备已授权）',
    crossDeviceAuthorized: true,
    identifiers: [
      { kind: 'login_id', value: 'login-1002', authorized: true, deviceId: 'D-B1' },
      { kind: 'device_id', value: 'D-B1', authorized: true, deviceId: 'D-B1' },
    ],
  },
  {
    personId: 'P-1003',
    displayName: '王芳（跨设备未授权）',
    crossDeviceAuthorized: false,
    identifiers: [
      { kind: 'email_hash', value: 'hash-cc33', authorized: true, deviceId: 'D-C1' },
      { kind: 'email_hash', value: 'hash-cc33', authorized: true, deviceId: 'D-C2' },
      { kind: 'device_id', value: 'D-C1', authorized: true, deviceId: 'D-C1' },
      { kind: 'device_id', value: 'D-C2', authorized: true, deviceId: 'D-C2' },
    ],
    note: '两台设备出现相同 email_hash，但缺少跨设备匹配授权；引擎禁止把 D-C1/D-C2 拼成同一旅程。',
  },
  {
    personId: 'P-1005',
    displayName: '周强（已授权跨设备+CRM）',
    crossDeviceAuthorized: true,
    identifiers: [
      { kind: 'login_id', value: 'login-1005', authorized: true, deviceId: 'D-E1' },
      { kind: 'crm_id', value: 'crm-5510', authorized: true, deviceId: 'D-E2' },
      { kind: 'device_id', value: 'D-E1', authorized: true, deviceId: 'D-E1' },
      { kind: 'device_id', value: 'D-E2', authorized: true, deviceId: 'D-E2' },
    ],
    note: 'CRM 匹配授权覆盖手机与平板，可跨设备归并。',
  },
  {
    personId: 'P-1006',
    displayName: '陈静（已授权，无订单级触点）',
    crossDeviceAuthorized: true,
    identifiers: [
      { kind: 'login_id', value: 'login-1006', authorized: true, deviceId: 'D-F1' },
      { kind: 'device_id', value: 'D-F1', authorized: true, deviceId: 'D-F1' },
    ],
  },
  // ---- 成熟评估群体：同客户多订单 + 分群标注 ----
  personLink('P-2001', '顾一（同客户两单）', 'D-G1', true),
  personLink('P-2002', '顾二（同客户两单）', 'D-G2', true),
  personLink('P-2003', '顾三（评估样本）', 'D-G3', true),
  personLink('P-2004', '顾四（同客户两单）', 'D-G4', true),
  personLink('P-2005', '顾五（同客户两单）', 'D-G5', true),
  personLink('P-2006', '顾六（评估样本）', 'D-G6', true),
  personLink('P-2007', '顾七（评估样本）', 'D-G7', true),
  personLink('P-2008', '顾八（同客户两单）', 'D-G8', true),
  personLink('P-2009', '顾九（跨设备未授权）', 'D-G9', false, '评估样本中演示订单簇回退：缺少跨设备授权，不能与同客户其他订单拼接。'),
  personLink('P-2010', '顾十（评估样本）', 'D-G10', true),
  personLink('P-2011', '顾十一（评估样本）', 'D-G11', true),
  // ---- 近期窗口群体 ----
  personLink('P-3001', '周近期（评估样本）', 'D-H1', true),
  personLink('P-3002', '吴近期（评估样本）', 'D-H2', true),
  personLink('P-3003', '郑近期（同客户两单）', 'D-H3', true),
  personLink('P-3004', '王近期（评估样本）', 'D-H4', true),
  personLink('P-3005', '冯近期（评估样本）', 'D-H5', true),
  // ---- 边界样本群体（渠道全未知） ----
  personLink('P-2402', '边界二（触点全未授权）', 'D-G12', false),
  personLink('P-2403', '边界三（无订单级触点）', 'D-G13', true),
];

function order(
  orderId: string,
  personId: string | null,
  deviceId: string,
  orderTime: string,
  grossAmount: number,
  touchpointIds: string[],
  region: string,
  deviceSegment: string,
  scenarioTag?: string,
  status: Order['status'] = 'placed',
): Order {
  return {
    orderId,
    personId,
    deviceId,
    orderTime,
    orderTimezone: 'Asia/Shanghai',
    grossAmount,
    currency: 'CNY',
    status,
    touchpointIds,
    ...(scenarioTag ? { scenarioTag } : {}),
    region,
    deviceSegment,
  };
}

function tp(
  touchpointId: string,
  orderId: string,
  personId: string | null,
  deviceId: string,
  channelId: string,
  campaignId: string,
  campaignName: string,
  eventTime: string,
  identityKind: Touchpoint['identityKind'] = 'login_id',
  authorized = true,
  timezone = 'Asia/Shanghai',
  eventType: Touchpoint['eventType'] = 'click',
): Touchpoint {
  return {
    touchpointId,
    orderId,
    personId,
    deviceId,
    channelId,
    campaignId,
    campaignName,
    eventTime,
    eventTimezone: timezone,
    eventType,
    identityKind,
    identityAuthorized: authorized,
  };
}

export const orders: Order[] = [
  // ---- 基础订单（跨设备、退款、未知、取消） ----
  order('O-2001', 'P-1001', 'D-A2', '2026-11-01T06:20:00Z', 129900, ['T-3001', 'T-3002', 'T-3003'], '华东', 'iOS', '跨设备已授权：手机搜索 → PC 社交 → PC 邮件'),
  order('O-2009', 'P-1001', 'D-A1', '2026-11-02T10:40:00Z', 45900, ['T-3004'], '华东', 'iOS'),
  order('O-2002', 'P-1002', 'D-B1', '2026-11-01T03:00:00Z', 89900, ['T-3005', 'T-3006'], '华南', 'Android', '迟到退款：运行锁定后 R-1006 到达，仅触发新运行'),
  order('O-2003', 'P-1003', 'D-C1', '2026-10-31T12:00:00Z', 59900, ['T-3007', 'T-3008'], '华东', 'Android', '跨设备未授权：D-C1 旅程不与 D-C2 合并'),
  order('O-2007', 'P-1003', 'D-C2', '2026-11-01T08:30:00Z', 25900, ['T-3009'], '华东', 'Android', '跨设备未授权：相同 email_hash 仍保持独立旅程'),
  order('O-2005', 'P-1005', 'D-E2', '2026-11-01T02:10:00Z', 249900, ['T-3010', 'T-3011', 'T-3012', 'T-3013'], '华南', 'iOS', '跨时区活动 + 部分退款（黑五全球场，洛杉矶曝光）', 'refunded_partial'),
  order('O-2004', null, 'D-X1', '2026-11-01T20:00:00Z', 39900, ['T-3014'], '西部', 'Android', '未知来源：无授权人员标识，收入单列不参与渠道分配'),
  order('O-2006', 'P-1006', 'D-F1', '2026-10-31T22:00:00Z', 15900, [], '华北', 'Desktop', '无订单标识点击：点击只存在于平台汇总区，订单级触点缺失 → 未知来源'),
  order('O-2008', 'P-1002', 'D-B1', '2026-10-31T16:00:00Z', 7900, ['T-3015'], '华南', 'Android', '已取消订单净额为 0，不参与分配但保留可查记录', 'cancelled'),

  // ---- 成熟评估群体 ----
  // 华东：社交在前、搜索在后（末次 vs 首次方向差异）
  order('O-2101', 'P-2001', 'D-G1', '2026-10-28T05:10:00Z', 39900, ['T-3101', 'T-3102'], '华东', 'iOS', '评估样本：同客户首单（社交 → 搜索）'),
  order('O-2102', 'P-2001', 'D-G1', '2026-10-30T09:00:00Z', 45900, ['T-3103', 'T-3104'], '华东', 'iOS', '评估样本：同客户第二单（社交 → 搜索）'),
  order('O-2103', 'P-2002', 'D-G2', '2026-10-29T03:20:00Z', 29900, ['T-3105', 'T-3106'], '华东', 'Android', '评估样本：社交 → 搜索'),
  order('O-2104', 'P-2002', 'D-G2', '2026-10-31T02:00:00Z', 54900, ['T-3107', 'T-3108'], '华东', 'Android', '评估样本：社交 → 邮件'),
  // 华南：搜索在前、展示/邮件在后
  order('O-2105', 'P-2003', 'D-G3', '2026-10-27T07:30:00Z', 89900, ['T-3109', 'T-3110'], '华南', 'iOS', '评估样本：搜索 → 展示（存在未成熟退款，默认样本排除）'),
  order('O-2106', 'P-2004', 'D-G4', '2026-10-26T11:00:00Z', 129900, ['T-3111', 'T-3112'], '华南', 'Android', '评估样本：同客户搜索 → 邮件'),
  order('O-2107', 'P-2004', 'D-G4', '2026-10-29T13:40:00Z', 109900, ['T-3113', 'T-3114'], '华南', 'Android', '评估样本：同客户搜索 → 展示'),
  // 华北：搜索/邮件在前、社交在后（局部方向与总体相反）
  order('O-2108', 'P-2005', 'D-G5', '2026-10-25T04:50:00Z', 159900, ['T-3115'], '华北', 'Desktop', '评估样本：单触点搜索'),
  order('O-2109', 'P-2005', 'D-G5', '2026-10-28T06:10:00Z', 99900, ['T-3116', 'T-3117'], '华北', 'Desktop', '评估样本：同客户搜索 → 展示'),
  order('O-2110', 'P-2006', 'D-G6', '2026-10-30T08:30:00Z', 119900, ['T-3118', 'T-3119'], '华北', 'iOS', '评估样本：搜索 → 邮件'),
  order('O-2115', 'P-2010', 'D-G10', '2026-10-29T10:30:00Z', 79900, ['T-3128', 'T-3129'], '华北', 'Android', '评估样本：搜索 → 社交（社交收口，制造局部方向相反）'),
  order('O-2116', 'P-2011', 'D-G11', '2026-10-31T01:00:00Z', 59900, ['T-3130', 'T-3131'], '华北', 'Android', '评估样本：邮件 → 社交（社交收口）'),
  // 西部：展示在前、搜索在后
  order('O-2111', 'P-2007', 'D-G7', '2026-10-31T10:00:00Z', 49900, ['T-3120', 'T-3121'], '西部', 'Android', '评估样本：展示 → 搜索（演示退款补齐）'),
  order('O-2112', 'P-2008', 'D-G8', '2026-10-28T15:20:00Z', 59900, ['T-3122', 'T-3123'], '西部', 'Desktop', '评估样本：同客户展示 → 邮件'),
  order('O-2113', 'P-2008', 'D-G8', '2026-10-30T12:00:00Z', 39900, ['T-3124', 'T-3125'], '西部', 'Desktop', '评估样本：同客户展示 → 搜索'),
  order('O-2114', 'P-2009', 'D-G9', '2026-10-31T05:00:00Z', 54900, ['T-3126', 'T-3127'], '华东', 'Desktop', '评估样本：跨设备未授权，按订单簇处理'),

  // ---- 近期窗口（11-05 ~ 11-14）：展示广告占比上升、新增平板、西部缺失 ----
  order('O-2201', 'P-3001', 'D-H1', '2026-11-13T06:00:00Z', 69900, ['T-3201', 'T-3202'], '华东', 'iOS', '近期窗口：展示 → 搜索'),
  order('O-2202', 'P-3002', 'D-H2', '2026-11-12T04:30:00Z', 39900, ['T-3203', 'T-3204'], '华东', 'Android', '近期窗口：展示 → 邮件'),
  order('O-2203', 'P-3003', 'D-H3', '2026-11-14T09:00:00Z', 159900, ['T-3205', 'T-3206'], '华南', 'iOS', '近期窗口：展示 → 搜索（退款未成熟，默认排除）'),
  order('O-2204', 'P-3003', 'D-H3', '2026-11-13T12:00:00Z', 109900, ['T-3207', 'T-3208'], '华南', 'Tablet', '近期窗口：同客户展示 → 展示（新增平板设备群）'),
  order('O-2205', 'P-3004', 'D-H4', '2026-11-11T08:10:00Z', 89900, ['T-3209', 'T-3210'], '华北', 'Desktop', '近期窗口：展示 → 搜索'),
  order('O-2206', 'P-3005', 'D-H5', '2026-11-10T05:40:00Z', 49900, ['T-3211'], '华北', 'Android', '近期窗口：单触点展示'),

  // ---- 边界样本：所有订单都落入未知来源（渠道全未知） ----
  order('O-2401', null, 'D-X2', '2026-11-03T06:00:00Z', 29900, ['T-3401'], '华东', 'Android', '边界样本：无人员标识 + 未授权触点'),
  order('O-2402', 'P-2402', 'D-G12', '2026-11-03T07:00:00Z', 34900, ['T-3402'], '华东', 'Android', '边界样本：有人员但触点未授权（且无跨设备授权）'),
  order('O-2403', 'P-2403', 'D-G13', '2026-11-03T08:00:00Z', 25900, [], '华东', 'Android', '边界样本：有人员但无任何订单级触点'),
];

export const touchpoints: Touchpoint[] = [
  // O-2001 跨设备旅程（P-1001 已授权）
  tp('T-3001', 'O-2001', 'P-1001', 'D-A1', 'C-SEM', 'CMP-BRAND', '品牌词搜索', '2026-10-28T09:12:00Z'),
  tp('T-3002', 'O-2001', 'P-1001', 'D-A2', 'C-SOCIAL', 'CMP-FEED', '秋季信息流', '2026-10-30T13:40:00Z'),
  tp('T-3003', 'O-2001', 'P-1001', 'D-A2', 'C-EMAIL', 'CMP-EDM', '双11 提醒邮件', '2026-11-01T05:50:00Z'),
  // O-2009
  tp('T-3004', 'O-2009', 'P-1001', 'D-A1', 'C-SEM', 'CMP-BRAND', '品牌词搜索', '2026-11-02T10:00:00Z'),
  // O-2002
  tp('T-3005', 'O-2002', 'P-1002', 'D-B1', 'C-SOCIAL', 'CMP-FEED', '秋季信息流', '2026-10-29T02:00:00Z'),
  tp('T-3006', 'O-2002', 'P-1002', 'D-B1', 'C-DISPLAY', 'CMP-BANNER', '再营销横幅', '2026-10-31T07:30:00Z'),
  // O-2003（D-C1，未授权跨设备）
  tp('T-3007', 'O-2003', 'P-1003', 'D-C1', 'C-DISPLAY', 'CMP-BANNER', '再营销横幅', '2026-10-27T20:00:00Z', 'email_hash', true, 'Asia/Shanghai', 'impression'),
  tp('T-3008', 'O-2003', 'P-1003', 'D-C1', 'C-SOCIAL', 'CMP-FEED', '秋季信息流', '2026-10-30T11:00:00Z', 'email_hash'),
  // O-2007（D-C2，同 email_hash 但不合并）
  tp('T-3009', 'O-2007', 'P-1003', 'D-C2', 'C-SEM', 'CMP-BRAND', '品牌词搜索', '2026-10-31T09:00:00Z', 'email_hash'),
  // 同一订单在 D-C1 上的触点：因 P-1003 无跨设备授权，引擎必须把它排除在 D-C2 旅程之外
  tp('T-3016', 'O-2007', 'P-1003', 'D-C1', 'C-DISPLAY', 'CMP-BANNER', '再营销横幅', '2026-10-30T18:00:00Z', 'email_hash', true, 'Asia/Shanghai', 'impression'),
  // O-2005 跨时区
  tp('T-3010', 'O-2005', 'P-1005', 'D-E1', 'C-DISPLAY', 'CMP-GLOBAL', '黑五全球场', '2026-10-26T10:00:00Z', 'login_id', true, 'America/Los_Angeles', 'impression'),
  tp('T-3011', 'O-2005', 'P-1005', 'D-E1', 'C-SOCIAL', 'CMP-FEED', '秋季信息流', '2026-10-28T15:00:00Z'),
  tp('T-3012', 'O-2005', 'P-1005', 'D-E2', 'C-SEM', 'CMP-BRAND', '品牌词搜索', '2026-10-30T08:15:00Z', 'crm_id'),
  tp('T-3013', 'O-2005', 'P-1005', 'D-E2', 'C-EMAIL', 'CMP-EDM', '黑五预售邮件', '2026-11-01T01:00:00Z', 'crm_id', true, 'America/Los_Angeles'),
  // O-2004 未知设备（device_id 未授权，无人员标识）
  tp('T-3014', 'O-2004', null, 'D-X1', 'C-DISPLAY', 'CMP-BANNER', '再营销横幅', '2026-10-31T19:00:00Z', 'device_id', false),
  // O-2008 取消单
  tp('T-3015', 'O-2008', 'P-1002', 'D-B1', 'C-SOCIAL', 'CMP-FEED', '秋季信息流', '2026-10-30T13:00:00Z'),

  // ---- 成熟评估群体触点 ----
  tp('T-3101', 'O-2101', 'P-2001', 'D-G1', 'C-SOCIAL', 'CMP-FEED', '秋季信息流', '2026-10-24T06:00:00Z'),
  tp('T-3102', 'O-2101', 'P-2001', 'D-G1', 'C-SEM', 'CMP-BRAND', '品牌词搜索', '2026-10-27T22:00:00Z'),
  tp('T-3103', 'O-2102', 'P-2001', 'D-G1', 'C-SOCIAL', 'CMP-FEED', '秋季信息流', '2026-10-26T03:00:00Z'),
  tp('T-3104', 'O-2102', 'P-2001', 'D-G1', 'C-SEM', 'CMP-BRAND', '品牌词搜索', '2026-10-29T23:10:00Z'),
  tp('T-3105', 'O-2103', 'P-2002', 'D-G2', 'C-SOCIAL', 'CMP-FEED', '秋季信息流', '2026-10-25T08:00:00Z'),
  tp('T-3106', 'O-2103', 'P-2002', 'D-G2', 'C-SEM', 'CMP-BRAND', '品牌词搜索', '2026-10-28T21:00:00Z'),
  tp('T-3107', 'O-2104', 'P-2002', 'D-G2', 'C-SOCIAL', 'CMP-FEED', '秋季信息流', '2026-10-27T10:00:00Z'),
  tp('T-3108', 'O-2104', 'P-2002', 'D-G2', 'C-EMAIL', 'CMP-EDM', '双11 提醒邮件', '2026-10-31T00:30:00Z'),
  tp('T-3109', 'O-2105', 'P-2003', 'D-G3', 'C-SEM', 'CMP-BRAND', '品牌词搜索', '2026-10-23T02:00:00Z'),
  tp('T-3110', 'O-2105', 'P-2003', 'D-G3', 'C-DISPLAY', 'CMP-BANNER', '再营销横幅', '2026-10-26T23:00:00Z'),
  tp('T-3111', 'O-2106', 'P-2004', 'D-G4', 'C-SEM', 'CMP-BRAND', '品牌词搜索', '2026-10-22T01:00:00Z'),
  tp('T-3112', 'O-2106', 'P-2004', 'D-G4', 'C-EMAIL', 'CMP-EDM', '双11 提醒邮件', '2026-10-25T22:00:00Z'),
  tp('T-3113', 'O-2107', 'P-2004', 'D-G4', 'C-SEM', 'CMP-BRAND', '品牌词搜索', '2026-10-25T07:00:00Z'),
  tp('T-3114', 'O-2107', 'P-2004', 'D-G4', 'C-DISPLAY', 'CMP-BANNER', '再营销横幅', '2026-10-29T02:30:00Z'),
  tp('T-3115', 'O-2108', 'P-2005', 'D-G5', 'C-SEM', 'CMP-BRAND', '品牌词搜索', '2026-10-24T22:00:00Z'),
  tp('T-3116', 'O-2109', 'P-2005', 'D-G5', 'C-SEM', 'CMP-BRAND', '品牌词搜索', '2026-10-25T01:00:00Z'),
  tp('T-3117', 'O-2109', 'P-2005', 'D-G5', 'C-DISPLAY', 'CMP-BANNER', '再营销横幅', '2026-10-27T23:00:00Z'),
  tp('T-3118', 'O-2110', 'P-2006', 'D-G6', 'C-SEM', 'CMP-BRAND', '品牌词搜索', '2026-10-26T01:00:00Z'),
  tp('T-3119', 'O-2110', 'P-2006', 'D-G6', 'C-EMAIL', 'CMP-EDM', '双11 提醒邮件', '2026-10-30T00:00:00Z'),
  tp('T-3120', 'O-2111', 'P-2007', 'D-G7', 'C-DISPLAY', 'CMP-BANNER', '再营销横幅', '2026-10-26T05:00:00Z'),
  tp('T-3121', 'O-2111', 'P-2007', 'D-G7', 'C-SEM', 'CMP-BRAND', '品牌词搜索', '2026-10-31T03:00:00Z'),
  tp('T-3122', 'O-2112', 'P-2008', 'D-G8', 'C-DISPLAY', 'CMP-BANNER', '再营销横幅', '2026-10-25T02:00:00Z'),
  tp('T-3123', 'O-2112', 'P-2008', 'D-G8', 'C-EMAIL', 'CMP-EDM', '双11 提醒邮件', '2026-10-28T05:00:00Z'),
  tp('T-3124', 'O-2113', 'P-2008', 'D-G8', 'C-DISPLAY', 'CMP-BANNER', '再营销横幅', '2026-10-27T04:00:00Z'),
  tp('T-3125', 'O-2113', 'P-2008', 'D-G8', 'C-SEM', 'CMP-BRAND', '品牌词搜索', '2026-10-30T01:00:00Z'),
  tp('T-3126', 'O-2114', 'P-2009', 'D-G9', 'C-SEM', 'CMP-BRAND', '品牌词搜索', '2026-10-28T02:00:00Z'),
  tp('T-3127', 'O-2114', 'P-2009', 'D-G9', 'C-DISPLAY', 'CMP-BANNER', '再营销横幅', '2026-10-31T01:30:00Z'),
  tp('T-3128', 'O-2115', 'P-2010', 'D-G10', 'C-SEM', 'CMP-BRAND', '品牌词搜索', '2026-10-27T02:00:00Z'),
  tp('T-3129', 'O-2115', 'P-2010', 'D-G10', 'C-SOCIAL', 'CMP-FEED', '秋季信息流', '2026-10-29T09:00:00Z'),
  tp('T-3130', 'O-2116', 'P-2011', 'D-G11', 'C-EMAIL', 'CMP-EDM', '双11 提醒邮件', '2026-10-28T03:00:00Z'),
  tp('T-3131', 'O-2116', 'P-2011', 'D-G11', 'C-SOCIAL', 'CMP-FEED', '秋季信息流', '2026-10-31T00:00:00Z'),

  // ---- 近期窗口触点 ----
  tp('T-3201', 'O-2201', 'P-3001', 'D-H1', 'C-DISPLAY', 'CMP-BANNER', '再营销横幅', '2026-11-08T02:00:00Z'),
  tp('T-3202', 'O-2201', 'P-3001', 'D-H1', 'C-SEM', 'CMP-BRAND', '品牌词搜索', '2026-11-13T01:00:00Z'),
  tp('T-3203', 'O-2202', 'P-3002', 'D-H2', 'C-DISPLAY', 'CMP-BANNER', '再营销横幅', '2026-11-07T03:00:00Z'),
  tp('T-3204', 'O-2202', 'P-3002', 'D-H2', 'C-EMAIL', 'CMP-EDM', '双11 提醒邮件', '2026-11-12T01:30:00Z'),
  tp('T-3205', 'O-2203', 'P-3003', 'D-H3', 'C-DISPLAY', 'CMP-BANNER', '再营销横幅', '2026-11-09T04:00:00Z'),
  tp('T-3206', 'O-2203', 'P-3003', 'D-H3', 'C-SEM', 'CMP-BRAND', '品牌词搜索', '2026-11-14T02:00:00Z'),
  tp('T-3207', 'O-2204', 'P-3003', 'D-H3', 'C-DISPLAY', 'CMP-BANNER', '再营销横幅', '2026-11-10T05:00:00Z'),
  tp('T-3208', 'O-2204', 'P-3003', 'D-H3', 'C-DISPLAY', 'CMP-RETARGET', '展示再营销（二次）', '2026-11-13T06:00:00Z'),
  tp('T-3209', 'O-2205', 'P-3004', 'D-H4', 'C-DISPLAY', 'CMP-BANNER', '再营销横幅', '2026-11-06T02:00:00Z'),
  tp('T-3210', 'O-2205', 'P-3004', 'D-H4', 'C-SEM', 'CMP-BRAND', '品牌词搜索', '2026-11-11T01:00:00Z'),
  tp('T-3211', 'O-2206', 'P-3005', 'D-H5', 'C-DISPLAY', 'CMP-BANNER', '再营销横幅', '2026-11-09T00:00:00Z'),

  // ---- 边界样本触点（全部不可用于归因） ----
  tp('T-3401', 'O-2401', null, 'D-X2', 'C-SEM', 'CMP-BRAND', '品牌词搜索', '2026-11-02T20:00:00Z', 'device_id', false),
  tp('T-3402', 'O-2402', 'P-2402', 'D-G12', 'C-DISPLAY', 'CMP-BANNER', '再营销横幅', '2026-11-02T21:00:00Z', 'email_hash', false),
];

export const refundsV1: RefundEvent[] = [
  { refundId: 'R-1005', orderId: 'O-2005', amount: 40000, refundTime: '2026-11-01T09:30:00Z', reason: '部分商品缺货退款', dataVersion: 'DV-2026.11.01', refundBatchId: 'RB-1005' },
];

export const refundsV2: RefundEvent[] = [
  ...refundsV1,
  { refundId: 'R-1006', orderId: 'O-2002', amount: 20000, refundTime: '2026-11-04T08:15:00Z', reason: '价保补差退款（晚于广告回传与运行锁定）', dataVersion: 'DV-2026.11.05', refundBatchId: 'RB-1006' },
];

export const refundsV3: RefundEvent[] = [
  ...refundsV2,
  // 成熟样本观察截止点（11-07）之后才到：默认成熟条件会排除该订单，演示「未成熟退款」
  { refundId: 'R-1030', orderId: 'O-2105', amount: 15000, refundTime: '2026-11-12T04:00:00Z', reason: '迟到的部分退款（晚于成熟样本观察截止点）', dataVersion: 'DV-2026.11.15', refundBatchId: 'RB-1030' },
  // 近期窗口观察截止点（11-14）之后才到：漂移监测中标注未成熟，需等待退款观察完成
  { refundId: 'R-1020', orderId: 'O-2203', amount: 30000, refundTime: '2026-11-18T03:00:00Z', reason: '近期窗口退货退款尚未入账', dataVersion: 'DV-2026.11.15', refundBatchId: 'RB-1020' },
];

/** 平台点击汇总：无订单级标识，只能留在平台汇总区 */
export const platformClicks: PlatformClickAggregate[] = [
  { aggId: 'A-01', platform: 'Google Ads', channelId: 'C-SEM', campaignId: 'CMP-BRAND', day: '2026-10-30', clicks: 12000, cost: 380000, hasOrderIdentifier: false, note: '平台仅回传日级汇总，无订单级标识' },
  { aggId: 'A-02', platform: 'Meta', channelId: 'C-SOCIAL', campaignId: 'CMP-FEED', day: '2026-10-30', clicks: 8400, cost: 260000, hasOrderIdentifier: false },
  { aggId: 'A-03', platform: 'The Trade Desk', channelId: 'C-DISPLAY', campaignId: 'CMP-BANNER', day: '2026-10-30', clicks: 3100, cost: 120000, hasOrderIdentifier: false },
  { aggId: 'A-04', platform: '自有营销云', channelId: 'C-EMAIL', campaignId: 'CMP-EDM', day: '2026-10-30', clicks: 900, cost: 5000, hasOrderIdentifier: false },
  { aggId: 'A-05', platform: 'Meta', channelId: 'C-SOCIAL', campaignId: 'CMP-FEED', day: '2026-11-01', clicks: 7600, cost: 235000, hasOrderIdentifier: false, note: 'O-2006 的点击只在此汇总中，无法关联到订单' },
  { aggId: 'A-06', platform: '联盟网络', channelId: 'C-AFFILIATE', campaignId: 'CMP-AFF', day: '2026-10-30', clicks: 5200, cost: 90000, hasOrderIdentifier: false, note: '联盟流量无订单级触点回传，评估中该渠道从未覆盖' },
  { aggId: 'A-07', platform: '自有', channelId: 'C-ORGANIC', campaignId: 'CMP-ORGANIC', day: '2026-10-30', clicks: 4300, cost: 0, hasOrderIdentifier: false, note: '自然流量无付费触点，评估中该渠道从未覆盖' },
];

function jobs(version: string, quarantine: boolean, orderCount: number, touchpointCount: number, refundCount: number): IngestionJob[] {
  const base: IngestionJob[] = [
    { jobId: `J-${version}-01`, source: '订单中心 API', stream: 'orders', fetchedAt: '2026-11-01T00:05:00Z', recordCount: orderCount, checksum: 'sha256:9f1c…b2', status: 'success' },
    { jobId: `J-${version}-02`, source: '广告触点回传（订单级）', stream: 'order_touchpoints', fetchedAt: '2026-11-01T00:07:00Z', recordCount: touchpointCount, checksum: 'sha256:41ab…7d', status: 'success' },
    { jobId: `J-${version}-03`, source: '平台日级点击汇总', stream: 'platform_click_aggregate', fetchedAt: '2026-11-01T00:09:00Z', recordCount: platformClicks.length, checksum: 'sha256:77d0…e8', status: 'success', note: '全部缺少订单级标识，路由到平台汇总区' },
    { jobId: `J-${version}-04`, source: '身份授权服务', stream: 'identity', fetchedAt: '2026-11-01T00:03:00Z', recordCount: identityLinks.length, checksum: 'sha256:c0de…11', status: 'success' },
    { jobId: `J-${version}-05`, source: '退款流水', stream: 'refund', fetchedAt: '2026-11-01T00:11:00Z', recordCount: refundCount, checksum: version === 'v1' ? 'sha256:55aa…03' : version === 'v2' ? 'sha256:88bb…19' : 'sha256:9ac0…4e', status: 'success' },
  ];
  if (quarantine) {
    base.push({
      jobId: `J-${version}-06`, source: '第三方 DSP 补传文件', stream: 'order_touchpoints',
      fetchedAt: '2026-11-01T00:13:00Z', recordCount: 0, checksum: 'sha256:err…00', status: 'quarantined',
      note: '缺少订单稳定标识与授权字段，整批隔离，不进入逐单分配',
    });
  }
  return base;
}

/** 净额管线：毛额 − 退款 = 净额（取消单净额为 0） */
export function buildOrderVersions(orderList: Order[], refunds: RefundEvent[], dataVersion: string): OrderVersion[] {
  return orderList.map((o) => {
    const related = refunds.filter((r) => r.orderId === o.orderId);
    const refundedAmount = related.reduce((s, r) => s + r.amount, 0);
    const netAmount = o.status === 'cancelled' ? 0 : Math.max(0, o.grossAmount - refundedAmount);
    const status =
      o.status === 'cancelled'
        ? 'cancelled'
        : refundedAmount >= o.grossAmount
          ? 'refunded_full'
          : refundedAmount > 0
            ? 'refunded_partial'
            : 'placed';
    return {
      orderId: o.orderId,
      dataVersion,
      grossAmount: o.grossAmount,
      refundedAmount,
      netAmount,
      status,
      refundIds: related.map((r) => r.refundId),
    };
  });
}

/** 快照 11-01 / 11-05 只含基础订单（与既有归因运行一致）；11-15 含评估、近期与边界群体 */
const baseOrders = orders.filter((o) => o.orderId.startsWith('O-20'));
const baseTouchpoints = touchpoints.filter((t) => t.touchpointId.startsWith('T-30') || t.touchpointId.startsWith('T-3016'));

export const snapshots: DataSnapshot[] = [
  {
    snapshotId: 'DS-2026-11-01',
    dataVersion: 'DV-2026.11.01',
    ruleRevision: RULE_REVISION_V1,
    createdAt: '2026-11-01T00:20:00Z',
    ingestionJobs: jobs('v1', true, baseOrders.length, baseTouchpoints.length, refundsV1.length),
    channels,
    identityLinks,
    // 只保留该版本时点已有的订单（不把未来的评估群体写入早期快照）
    orders: baseOrders,
    touchpoints: baseTouchpoints,
    refunds: refundsV1,
    orderVersions: buildOrderVersions(baseOrders, refundsV1, 'DV-2026.11.01'),
    platformClicks,
  },
  {
    snapshotId: 'DS-2026-11-05',
    dataVersion: 'DV-2026.11.05',
    ruleRevision: RULE_REVISION_V2,
    createdAt: '2026-11-05T01:00:00Z',
    ingestionJobs: jobs('v2', false, baseOrders.length, baseTouchpoints.length, refundsV2.length),
    channels,
    identityLinks,
    orders: baseOrders,
    touchpoints: baseTouchpoints,
    refunds: refundsV2,
    orderVersions: buildOrderVersions(baseOrders, refundsV2, 'DV-2026.11.05'),
    platformClicks,
  },
  {
    snapshotId: 'DS-2026-11-15',
    dataVersion: 'DV-2026.11.15',
    ruleRevision: RULE_REVISION_V3,
    createdAt: '2026-11-15T01:00:00Z',
    ingestionJobs: jobs('v3', false, orders.length, touchpoints.length, refundsV3.length),
    channels,
    identityLinks,
    orders,
    touchpoints,
    refunds: refundsV3,
    orderVersions: buildOrderVersions(orders, refundsV3, 'DV-2026.11.15'),
    platformClicks,
  },
];

export const RECENT_SNAPSHOT_ID = 'DS-2026-11-15';
export const MATURE_SNAPSHOT_ID = 'DS-2026-11-15';
/** 迟到退款 R-1006 到达的快照：归因运行「基于新退款生成新运行」应指向它，而不是评估用的 11-15 */
export const LATE_REFUND_SNAPSHOT_ID = 'DS-2026-11-05';

// ---------------- 模型登记（内置） ----------------

function rev(
  revision: string,
  baseModel: ModelRegistryEntry['revisions'][number]['baseModel'],
  halfLife: number,
  ruleText: string,
  allowedUses: ModelRegistryEntry['revisions'][number]['allowedUses'],
  createdAt: string,
  createdBy: string,
  note: string,
): ModelRegistryEntry['revisions'][number] {
  return { revision, baseModel, decayHalfLifeDays: halfLife, ruleText, allowedUses, createdAt, createdBy, note };
}

export const seedModelRegistry: ModelRegistryEntry[] = [
  {
    registryId: 'MDL-LAST-TOUCH',
    name: '末次触点规则',
    currentRevision: 'v1',
    status: 'active',
    createdAt: '2026-10-01T00:00:00Z',
    createdBy: 'U-1001',
    revisions: [
      rev('v1', 'last_touch', 7, '全部份额给成交前最后一个合格触点；窗口内按事件时间排序。', ['version_compare', 'drift_monitor', 'review_basis'], '2026-10-01T00:00:00Z', 'U-1001', '初始登记'),
    ],
  },
  {
    registryId: 'MDL-FIRST-TOUCH',
    name: '首次触点规则',
    currentRevision: 'v1',
    status: 'active',
    createdAt: '2026-10-01T00:00:00Z',
    createdBy: 'U-1001',
    revisions: [
      rev('v1', 'first_touch', 7, '全部份额给首个合格触点；窗口内按事件时间排序。', ['version_compare', 'drift_monitor', 'review_basis'], '2026-10-01T00:00:00Z', 'U-1001', '初始登记'),
    ],
  },
  {
    registryId: 'MDL-LINEAR',
    name: '线性分摊规则',
    currentRevision: 'v1',
    status: 'active',
    createdAt: '2026-10-01T00:00:00Z',
    createdBy: 'U-1001',
    revisions: [
      rev('v1', 'linear', 7, '旅程内所有合格触点平分净额。', ['version_compare', 'drift_monitor', 'review_basis'], '2026-10-01T00:00:00Z', 'U-1001', '初始登记'),
    ],
  },
  {
    registryId: 'MDL-TIME-DECAY',
    name: '时间衰减规则',
    currentRevision: 'v1',
    status: 'active',
    createdAt: '2026-10-01T00:00:00Z',
    createdBy: 'U-1001',
    revisions: [
      rev('v1', 'time_decay', 7, '半衰期 7 天，越接近成交权重越高。', ['version_compare', 'drift_monitor', 'review_basis'], '2026-10-01T00:00:00Z', 'U-1001', '初始登记'),
    ],
  },
  {
    registryId: 'MDL-POSITION',
    name: '位置加权（U 型）规则',
    currentRevision: 'v1',
    status: 'active',
    createdAt: '2026-10-01T00:00:00Z',
    createdBy: 'U-1001',
    revisions: [
      rev('v1', 'position_based', 7, '首末触点各 40%，中间触点平分 20%。', ['version_compare', 'drift_monitor', 'review_basis'], '2026-10-01T00:00:00Z', 'U-1001', '初始登记'),
    ],
  },
  {
    registryId: 'MDL-BRAND-CAUTIOUS',
    name: '品牌保守规则（仅漂移监测）',
    currentRevision: 'v1',
    status: 'active',
    createdAt: '2026-10-20T00:00:00Z',
    createdBy: 'U-2001',
    revisions: [
      rev('v1', 'last_touch', 7, '与末次触点相同的规则，但用途仅登记为漂移监测，不可用于版本比较与审查依据。', ['drift_monitor'], '2026-10-20T00:00:00Z', 'U-2001', '演示「模型不允许该用途」'),
    ],
  },
];

// ---------------- 评估样本定义（内置） ----------------

export const seedSampleDefinitions: SampleDefinition[] = [
  {
    sampleId: 'SMP-MATURE-2026-11',
    label: '成熟共同样本（订单 10-15 ~ 11-01）',
    window: 'mature',
    baseSnapshotId: MATURE_SNAPSHOT_ID,
    dataVersion: 'DV-2026.11.15',
    supplementIds: [],
    windowStart: '2026-10-15T00:00:00Z',
    windowEnd: '2026-11-01T23:59:59Z',
    refundCutoff: '2026-11-07T23:59:59Z',
    maturityCondition: 'refund_settled_before_cutoff',
    observeDays: 14,
    attributionWindowDays: 7,
    timezone: 'Asia/Shanghai',
    segmentKeys: ['region', 'deviceSegment'],
    revision: 1,
    createdAt: '2026-11-08T00:00:00Z',
    createdBy: 'U-1001',
  },
  {
    sampleId: 'SMP-RECENT-2026-11',
    label: '近期窗口（订单 11-05 ~ 11-14，漂移监测）',
    window: 'recent',
    baseSnapshotId: RECENT_SNAPSHOT_ID,
    dataVersion: 'DV-2026.11.15',
    supplementIds: [],
    windowStart: '2026-11-05T00:00:00Z',
    windowEnd: '2026-11-14T23:59:59Z',
    refundCutoff: '2026-11-14T23:59:59Z',
    maturityCondition: 'refund_settled_before_cutoff',
    observeDays: 7,
    attributionWindowDays: 7,
    timezone: 'Asia/Shanghai',
    segmentKeys: ['region', 'deviceSegment'],
    revision: 1,
    createdAt: '2026-11-15T00:00:00Z',
    createdBy: 'U-1001',
  },
  {
    sampleId: 'SMP-EDGE-UNKNOWN',
    label: '边界样本（11-03，渠道全未知）',
    window: 'mature',
    baseSnapshotId: RECENT_SNAPSHOT_ID,
    dataVersion: 'DV-2026.11.15',
    supplementIds: [],
    windowStart: '2026-11-03T00:00:00Z',
    windowEnd: '2026-11-03T23:59:59Z',
    refundCutoff: '2026-11-04T23:59:59Z',
    maturityCondition: 'refund_settled_before_cutoff',
    observeDays: 7,
    attributionWindowDays: 7,
    timezone: 'Asia/Shanghai',
    segmentKeys: ['region', 'deviceSegment'],
    revision: 1,
    createdAt: '2026-11-08T00:00:00Z',
    createdBy: 'U-1001',
  },
];

/** 声明式「当前时间」：构建样本时用于观察期判定 */
export const SAMPLE_AS_OF = EVAL_AS_OF;

// ---------------- 内置补充导入模板 ----------------

/** 迟到退款补充：成熟截止点（11-07）之前到达，刷新样本后 O-2111 净额下降 */
export function lateRefundSupplement(importedBy: string): SupplementBatch {
  const refund: RefundEvent = {
    refundId: 'R-1010',
    orderId: 'O-2111',
    amount: 20000,
    refundTime: '2026-11-06T04:00:00Z',
    reason: '价保补差退款（成熟样本观察截止点前到达）',
    dataVersion: 'DV-2026.11.06',
    refundBatchId: 'RB-1010',
  };
  return {
    batchId: 'SUP-REFUND-1010',
    label: '迟到退款补充（R-1010 / O-2111）',
    importedAt: '2026-11-09T02:00:00Z',
    importedBy,
    note: '补齐 O-2111 的退款；刷新样本后只改变净额与渠道分摊，不改变样本成员，可用于「只更新退款」对照。',
    channels: [],
    orders: [],
    touchpoints: [],
    refunds: [refund],
    validation: { ok: true, issues: [] },
  };
}

/** 订单补充模板：新增一笔西部订单（导入后进入成熟样本） */
export function regionalOrderSupplement(importedBy: string): SupplementBatch {
  const newOrder = order('O-2301', 'P-2007', 'D-G7', '2026-10-31T14:00:00Z', 69900, ['T-3301', 'T-3302'], '西部', 'Android', '用户导入补充：展示 → 邮件（新订单）');
  const touchpointsNew = [
    tp('T-3301', 'O-2301', 'P-2007', 'D-G7', 'C-DISPLAY', 'CMP-BANNER', '再营销横幅', '2026-10-27T06:00:00Z'),
    tp('T-3302', 'O-2301', 'P-2007', 'D-G7', 'C-EMAIL', 'CMP-EDM', '双11 提醒邮件', '2026-10-31T13:00:00Z'),
  ];
  return {
    batchId: 'SUP-ORDER-2301',
    label: '订单补充（O-2301，西部 / Android）',
    importedAt: '2026-11-09T02:10:00Z',
    importedBy,
    note: '补充一笔西部订单，刷新样本后进入成熟共同样本。',
    channels: [],
    orders: [newOrder],
    touchpoints: touchpointsNew,
    refunds: [],
    validation: { ok: true, issues: [] },
  };
}
