import { createClient } from '@supabase/supabase-js';
import { userData } from '@src/store/user-data';
import { userDataStore } from '@src/infrastructure/prun-api/data/user-data';
import { sitesStore } from '@src/infrastructure/prun-api/data/sites';
import { getPlanetBurn } from '@src/core/burn';
import { workforcesStore } from '@src/infrastructure/prun-api/data/workforces';
import { productionStore } from '@src/infrastructure/prun-api/data/production';
import { watchUntil } from '@src/utils/watch';
import type {
  AuthResponse,
  MembersResponse,
  ApiError,
  ApiSuccess,
  InviteResponse,
  TreasuryBalanceResponse,
  TreasuryRecordsResponse,
  LogisticsListResponse,
  TasksListResponse,
  BulletinListResponse,
  ProductionSummaryResponse,
  ProductionItem,
  FactionMember,
  Bulletin,
  TransportRoute,
  TransportRoutesResponse,
  ShipStatusReport,
  ShipStatusResponse,
  TransportTrip,
  TransportBooking,
  TripsResponse,
  PluginUser,
  PluginUsersResponse,
  MemberRole,
} from './types';

const SUPABASE_URL = 'https://tnfncrvsengkativszlx.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_t2CpsRN_YxkqGDr-I5JJYQ_JWNCLvpB';

function companyToEmail(name: string): string {
  const hex = Array.from(new TextEncoder().encode(name), b => b.toString(16).padStart(2, '0')).join(
    '',
  );
  return `u_${hex}@faction.co`;
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    storage: {
      getItem: (key: string) => {
        const store = (userData.supabaseAuth ?? {}) as Record<string, string>;
        return store[key] ?? null;
      },
      setItem: (key: string, value: string) => {
        const store = ((userData.supabaseAuth as Record<string, string>) ?? {}) as Record<
          string,
          string
        >;
        store[key] = value;
        userData.supabaseAuth = store;
      },
      removeItem: (key: string) => {
        const store = ((userData.supabaseAuth as Record<string, string>) ?? {}) as Record<
          string,
          string
        >;
        delete store[key];
        userData.supabaseAuth = store;
      },
    },
  },
});

// --- Error class (same interface as before) ---

export class FactionApiError extends Error {
  public readonly code: string;
  constructor(public readonly response: ApiError) {
    super(response.message);
    this.code = response.error;
  }
}
function throwApi(code: string, message: string): never {
  throw new FactionApiError({ ok: false, error: code, message });
}

// --- Cache helpers (same as before) ---

function getCache() {
  return userData.factionCache as
    | { cachedAt: number; members?: FactionMember[]; balance?: number; bulletins?: Bulletin[] }
    | undefined;
}

function patchCache(patch: {
  members?: FactionMember[];
  balance?: number;
  bulletins?: Bulletin[];
}) {
  const existing = getCache();
  userData.factionCache = {
    ...(existing ?? {}),
    cachedAt: Date.now(),
    ...patch,
  } as typeof userData.factionCache;
}

export function clearCache() {
  userData.factionCache = undefined;
}

export function getCacheInfo(): { cachedAt: number } | undefined {
  const c = getCache();
  return c ? { cachedAt: c.cachedAt } : undefined;
}

// --- Auth ---

export async function register(
  companyName: string,
  pin: string,
  inviteCode: string,
): Promise<AuthResponse> {
  // 1. Validate invite code first
  const { error: invErr } = await supabase.rpc('validate_invite', { invite_code: inviteCode });
  if (invErr) throwApi('INVALID_INVITE', invErr.message);

  // 2. Sign up with Supabase Auth
  const { error: signUpErr } = await supabase.auth.signUp({
    email: companyToEmail(companyName),
    password: pin,
  });
  if (signUpErr) throwApi('SIGNUP_FAILED', signUpErr.message);

  // 3. Complete registration (creates member row, marks invite used)
  const { data, error: regErr } = await supabase.rpc('complete_registration', {
    invite_code: inviteCode,
    p_company_name: companyName,
  });
  if (regErr) throwApi('REGISTRATION_FAILED', regErr.message);

  const member = (data as { member: AuthResponse['member'] }).member;
  return {
    ok: true,
    token: 'supabase-session',
    member: {
      id: member.id,
      companyName: member.companyName,
      role: member.role,
      factionId: member.factionId,
    },
  };
}

export async function login(companyName: string, pin: string): Promise<AuthResponse> {
  const { error } = await supabase.auth.signInWithPassword({
    email: companyToEmail(companyName),
    password: pin,
  });
  if (error) throwApi('LOGIN_FAILED', error.message);

  // Fetch member info
  const { data: member, error: mErr } = await supabase
    .from('members')
    .select('id, company_name, role, faction_id')
    .eq('auth_uid', (await supabase.auth.getUser()).data.user!.id)
    .single();
  if ('message' in (mErr || {}) || !member) throwApi('NOT_FOUND', '未找到成员信息');

  // Sync username from game data
  const gameUsername = userDataStore.username;
  if (gameUsername) {
    await supabase.rpc('update_my_username', { p_username: gameUsername });
  }

  return {
    ok: true,
    token: 'supabase-session',
    member: {
      id: member.id,
      companyName: member.company_name,
      role: member.role,
      factionId: member.faction_id,
    },
  };
}

export async function logout() {
  await supabase.auth.signOut();
  clearCache();
}

export function isAuthenticated(): boolean {
  // Check if supabase has a session stored
  const store = (userData.supabaseAuth ?? {}) as Record<string, string>;
  return Object.keys(store).some(k => k.includes('auth-token'));
}

// --- Members ---

export async function fetchMembers(): Promise<MembersResponse & { fromCache?: boolean }> {
  try {
    const { data, error } = await supabase
      .from('members')
      .select('id, company_name, role, joined_at, username')
      .order('joined_at');
    if (error) throw error;

    const members: FactionMember[] = (data ?? []).map(r => ({
      id: r.id,
      companyName: r.company_name,
      username: r.username ?? undefined,
      role: r.role,
      joinedAt: r.joined_at,
    }));

    // Get my role
    const user = (await supabase.auth.getUser()).data.user;
    const me = members.find(m => {
      return user?.email === companyToEmail(m.companyName);
    });

    patchCache({ members });

    // Sync username from game data (fire-and-forget via RPC to bypass RLS)
    const gameUsername = userDataStore.username;
    if (gameUsername && me && me.username !== gameUsername) {
      supabase.rpc('update_my_username', { p_username: gameUsername }).then();
      me.username = gameUsername;
    }

    return { ok: true, members, myRole: (me?.role as FactionMember['role']) ?? 'member' };
  } catch {
    const cached = getCache();
    if (cached?.members) {
      return { ok: true, members: cached.members, myRole: 'member', fromCache: true };
    }
    throwApi('NETWORK_ERROR', '网络错误');
  }
}

export async function updateMemberRole(memberId: string, role: string): Promise<ApiSuccess> {
  const { error } = await supabase.from('members').update({ role }).eq('id', memberId);
  if (error) throwApi('UPDATE_FAILED', error.message);
  return { ok: true };
}

export async function removeMember(memberId: string): Promise<ApiSuccess> {
  const { error } = await supabase.from('members').delete().eq('id', memberId);
  if (error) throwApi('DELETE_FAILED', error.message);
  return { ok: true };
}

export async function createInviteCode(): Promise<InviteResponse> {
  const { data, error } = await supabase.rpc('create_invite_code');
  if (error) throwApi('CREATE_FAILED', error.message);
  return { ok: true, code: (data as { code: string }).code };
}

// --- Treasury ---

export async function fetchTreasuryBalance(): Promise<
  TreasuryBalanceResponse & { fromCache?: boolean }
> {
  try {
    const { data, error } = await supabase.rpc('get_treasury_balance');
    if (error) throw error;
    const balance = (data as { balance: number }).balance;
    patchCache({ balance });
    return { ok: true, balance };
  } catch {
    const cached = getCache();
    if (cached?.balance !== undefined) {
      return { ok: true, balance: cached.balance, fromCache: true };
    }
    throwApi('NETWORK_ERROR', '网络错误');
  }
}

export async function fetchTreasuryRecords(page = 1, limit = 20): Promise<TreasuryRecordsResponse> {
  const from = (page - 1) * limit;
  const to = from + limit - 1;

  const { data, error, count } = await supabase
    .from('treasury_records')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(from, to);
  if (error) throwApi('FETCH_FAILED', error.message);

  const records = (data ?? []).map(r => ({
    id: r.id,
    amount: r.amount,
    operator: r.operator,
    note: r.note,
    createdAt: r.created_at,
  }));
  return { ok: true, records, total: count ?? 0, page, limit };
}

export async function createTreasuryRecord(amount: number, note: string): Promise<ApiSuccess> {
  const myFaction = await supabase.rpc('get_my_faction_id' as never);
  const myName = await supabase.rpc('get_my_company_name' as never);
  const { error } = await supabase.from('treasury_records').insert({
    faction_id: (myFaction.data as string) ?? '',
    amount,
    operator: (myName.data as string) ?? '',
    note: note ?? '',
  });
  if (error) throwApi('CREATE_FAILED', error.message);
  return { ok: true };
}

// --- Logistics ---

export async function fetchLogistics(page = 1, limit = 20): Promise<LogisticsListResponse> {
  const from = (page - 1) * limit;
  const to = from + limit - 1;

  const { data, error, count } = await supabase
    .from('logistics_requests')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(from, to);
  if (error) throwApi('FETCH_FAILED', error.message);

  const requests = (data ?? []).map(r => ({
    id: r.id,
    requester: r.requester,
    materialTicker: r.material_ticker,
    quantity: r.quantity,
    destination: r.destination,
    reason: r.reason,
    status: r.status,
    reviewer: r.reviewer,
    reviewedAt: r.reviewed_at,
    createdAt: r.created_at,
  }));
  return { ok: true, requests, total: count ?? 0, page, limit };
}

export async function createLogisticsRequest(
  materialTicker: string,
  quantity: number,
  destination: string,
  reason: string,
): Promise<ApiSuccess> {
  const myFaction = await supabase.rpc('get_my_faction_id' as never);
  const myName = await supabase.rpc('get_my_company_name' as never);
  const { error } = await supabase.from('logistics_requests').insert({
    faction_id: (myFaction.data as string) ?? '',
    requester: (myName.data as string) ?? '',
    material_ticker: materialTicker,
    quantity,
    destination,
    reason: reason ?? '',
  });
  if (error) throwApi('CREATE_FAILED', error.message);
  return { ok: true };
}

export async function reviewLogistics(id: string, status: string): Promise<ApiSuccess> {
  const myName = await supabase.rpc('get_my_company_name' as never);
  const { error } = await supabase
    .from('logistics_requests')
    .update({
      status,
      reviewer: (myName.data as string) ?? '',
      reviewed_at: new Date().toISOString(),
    })
    .eq('id', id);
  if (error) throwApi('UPDATE_FAILED', error.message);
  return { ok: true };
}

// --- Tasks ---

export async function fetchTasks(page = 1, limit = 20): Promise<TasksListResponse> {
  const from = (page - 1) * limit;
  const to = from + limit - 1;

  const { data, error, count } = await supabase
    .from('tasks')
    .select('*, task_comments(*)', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(from, to);
  if (error) throwApi('FETCH_FAILED', error.message);

  const tasks = (data ?? []).map(r => ({
    id: r.id,
    title: r.title,
    description: r.description,
    assignee: r.assignee,
    createdBy: r.created_by,
    dueDate: r.due_date,
    status: r.status,
    comments: ((r.task_comments as Array<Record<string, unknown>>) ?? []).map(c => ({
      id: c.id as string,
      author: c.author as string,
      content: c.content as string,
      createdAt: c.created_at as string,
    })),
    createdAt: r.created_at,
  }));
  return { ok: true, tasks, total: count ?? 0, page, limit };
}

export async function createTask(
  title: string,
  description?: string,
  dueDate?: string,
  assignee?: string,
): Promise<ApiSuccess> {
  const myFaction = await supabase.rpc('get_my_faction_id' as never);
  const myName = await supabase.rpc('get_my_company_name' as never);
  const { error } = await supabase.from('tasks').insert({
    faction_id: (myFaction.data as string) ?? '',
    title,
    description: description ?? '',
    assignee: assignee ?? null,
    created_by: (myName.data as string) ?? '',
    due_date: dueDate ?? null,
  });
  if (error) throwApi('CREATE_FAILED', error.message);
  return { ok: true };
}

export async function claimTask(id: string): Promise<ApiSuccess> {
  const myName = await supabase.rpc('get_my_company_name' as never);
  const { error } = await supabase
    .from('tasks')
    .update({ assignee: (myName.data as string) ?? '', status: 'in_progress' })
    .eq('id', id);
  if (error) throwApi('UPDATE_FAILED', error.message);
  return { ok: true };
}

export async function updateTaskStatus(id: string, status: string): Promise<ApiSuccess> {
  const { error } = await supabase.from('tasks').update({ status }).eq('id', id);
  if (error) throwApi('UPDATE_FAILED', error.message);
  return { ok: true };
}

export async function addTaskComment(id: string, content: string): Promise<ApiSuccess> {
  const myName = await supabase.rpc('get_my_company_name' as never);
  const { error } = await supabase.from('task_comments').insert({
    task_id: id,
    author: (myName.data as string) ?? '',
    content,
  });
  if (error) throwApi('CREATE_FAILED', error.message);
  return { ok: true };
}

export async function deleteTask(id: string): Promise<ApiSuccess> {
  const { error } = await supabase.from('tasks').delete().eq('id', id);
  if (error) throwApi('DELETE_FAILED', error.message);
  return { ok: true };
}

// --- Production ---

export async function aggregateMyProduction(): Promise<{ ticker: string; quantity: number }[]> {
  const sites = sitesStore.all.value ?? [];

  // 触发所有 site 的 workforce 和 production 数据请求
  for (const site of sites) {
    workforcesStore.getById(site.siteId);
    productionStore.getBySiteId(site.siteId);
  }

  // 等待所有 site 的数据就绪（加上 15 秒超时，以防某些基地没有劳动力或产出数据而无限期挂起）
  await Promise.race([
    watchUntil(() =>
      sites.every(site => {
        const wf = workforcesStore.getById(site.siteId);
        const prod = productionStore.getBySiteId(site.siteId);
        return wf !== undefined && prod !== undefined;
      }),
    ),
    new Promise(resolve => setTimeout(resolve, 15000)),
  ]);

  // 分别汇总所有星球的产出、生产线消耗、人口消耗。
  const globalOutput: Record<string, number> = {};
  const globalInput: Record<string, number> = {};
  const globalWorkforce: Record<string, number> = {};
  for (const site of sites) {
    const planetBurn = getPlanetBurn(site);
    if (!planetBurn) {
      continue;
    }
    for (const [ticker, mat] of Object.entries(planetBurn.burn)) {
      globalOutput[ticker] = (globalOutput[ticker] ?? 0) + mat.output;
      globalInput[ticker] = (globalInput[ticker] ?? 0) + mat.input;
      globalWorkforce[ticker] = (globalWorkforce[ticker] ?? 0) + mat.workforce;
    }
  }

  // 全局净产出 = 全部产出 - 全部生产线消耗 - 全部人口消耗。
  const allTickers = new Set([
    ...Object.keys(globalOutput),
    ...Object.keys(globalInput),
    ...Object.keys(globalWorkforce),
  ]);
  const aggregated: Record<string, number> = {};
  for (const ticker of allTickers) {
    aggregated[ticker] =
      (globalOutput[ticker] ?? 0) - (globalInput[ticker] ?? 0) - (globalWorkforce[ticker] ?? 0);
  }

  return Object.entries(aggregated)
    .filter(([, qty]) => qty > 0)
    .map(([ticker, quantity]) => ({
      ticker,
      quantity: Math.round(quantity),
    }));
}

export async function reportProduction(items: ProductionItem[]): Promise<ApiSuccess> {
  const myFaction = await supabase.rpc('get_my_faction_id' as never);
  const myName = await supabase.rpc('get_my_company_name' as never);
  const factionId = (myFaction.data as string | null) ?? '';
  const companyName = (myName.data as string | null) ?? '';

  if (!factionId || !companyName) {
    throwApi('UNAUTHORIZED', '未找到组织成员信息，请重新登录组织面板');
  }

  const today = new Date().toISOString().slice(0, 10);

  const rows = items
    .filter(item => !!item.ticker && item.quantity > 0)
    .map(item => ({
      faction_id: factionId,
      company_name: companyName,
      material_ticker: item.ticker.toUpperCase(),
      quantity: item.quantity,
      report_date: today,
    }));

  await clearMyProductionSnapshot(factionId, companyName);

  if (rows.length === 0) {
    return { ok: true };
  }

  const { error } = await supabase.from('daily_production').insert(rows);
  if (error) throwApi('REPORT_FAILED', error.message);

  return { ok: true };
}

async function clearMyProductionSnapshot(factionId: string, companyName: string) {
  const { error } = await supabase
    .from('daily_production')
    .delete()
    .eq('faction_id', factionId)
    .eq('company_name', companyName);

  if (error) {
    throwApi('CLEAR_FAILED', error.message);
  }

  const { data, error: verifyError } = await supabase
    .from('daily_production')
    .select('id')
    .eq('faction_id', factionId)
    .eq('company_name', companyName)
    .limit(1);

  if (verifyError) {
    throwApi('CLEAR_FAILED', verifyError.message);
  }

  if ((data?.length ?? 0) > 0) {
    throwApi(
      'CLEAR_FAILED',
      '旧产出数据未能清除，请先在 Supabase 执行 daily_production 删除策略迁移',
    );
  }
}

interface ProductionSummaryRow {
  id: string;
  company_name: string;
  material_ticker: string;
  quantity: number;
  report_date: string;
}

interface ProductionMemberRow {
  company_name: string;
  username: string | null;
}

const SUPABASE_SELECT_PAGE_SIZE = 1000;

async function fetchAllDailyProductionRows(): Promise<ProductionSummaryRow[]> {
  const rows: ProductionSummaryRow[] = [];

  for (let from = 0; ; from += SUPABASE_SELECT_PAGE_SIZE) {
    const to = from + SUPABASE_SELECT_PAGE_SIZE - 1;
    const { data, error } = await supabase
      .from('daily_production')
      .select('id, company_name, material_ticker, quantity, report_date')
      .order('company_name')
      .order('material_ticker')
      .range(from, to);

    if (error) {
      throwApi('FETCH_FAILED', error.message);
    }

    rows.push(...((data ?? []) as ProductionSummaryRow[]));

    if ((data?.length ?? 0) < SUPABASE_SELECT_PAGE_SIZE) {
      return rows;
    }
  }
}

async function fetchAllProductionMembers(): Promise<ProductionMemberRow[]> {
  const rows: ProductionMemberRow[] = [];

  for (let from = 0; ; from += SUPABASE_SELECT_PAGE_SIZE) {
    const to = from + SUPABASE_SELECT_PAGE_SIZE - 1;
    const { data, error } = await supabase
      .from('members')
      .select('company_name, username')
      .order('company_name')
      .range(from, to);

    if (error) {
      throwApi('FETCH_FAILED', error.message);
    }

    rows.push(...((data ?? []) as ProductionMemberRow[]));

    if ((data?.length ?? 0) < SUPABASE_SELECT_PAGE_SIZE) {
      return rows;
    }
  }
}

export async function fetchProductionSummary(): Promise<ProductionSummaryResponse> {
  const today = new Date().toISOString().slice(0, 10);

  const [productionRows, memberRows] = await Promise.all([
    fetchAllDailyProductionRows(),
    fetchAllProductionMembers(),
  ]);

  const usernameMap: Record<string, string> = {};
  for (const m of memberRows) {
    if (m.username) usernameMap[m.company_name] = m.username;
  }

  type LatestProductionItem = {
    id: string;
    ticker: string;
    quantity: number;
    report_date: string;
  };

  const byMember: Record<string, Record<string, LatestProductionItem | undefined> | undefined> = {};

  for (const row of productionRows) {
    const tickerMap = (byMember[row.company_name] ??= {});
    const existing = tickerMap[row.material_ticker];
    if (existing === undefined || row.report_date > existing.report_date) {
      tickerMap[row.material_ticker] = {
        id: row.id,
        ticker: row.material_ticker,
        quantity: row.quantity,
        report_date: row.report_date,
      };
    }
  }

  const members = Object.entries(byMember).map(([companyName, tickerMap]) => ({
    companyName,
    username: usernameMap[companyName],
    items: Object.values(tickerMap ?? {}).filter(item => item !== undefined),
  }));
  return { ok: true, date: today, members };
}

export async function updateProductionQuantity(id: string, quantity: number): Promise<ApiSuccess> {
  const { error } = await supabase.from('daily_production').update({ quantity }).eq('id', id);
  if (error) throwApi('UPDATE_FAILED', error.message);
  return { ok: true };
}

export async function deleteProductionByMember(companyName: string): Promise<ApiSuccess> {
  const { error } = await supabase
    .from('daily_production')
    .delete()
    .eq('company_name', companyName);
  if (error) throwApi('DELETE_FAILED', error.message);
  return { ok: true };
}

// --- Bulletin ---

export async function fetchBulletins(
  page = 1,
  limit = 20,
): Promise<BulletinListResponse & { fromCache?: boolean }> {
  try {
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    const { data, error, count } = await supabase
      .from('bulletins')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(from, to);
    if (error) throw error;

    const bulletins: Bulletin[] = (data ?? []).map(r => ({
      id: r.id,
      title: r.title,
      content: r.content,
      author: r.author,
      createdAt: r.created_at,
    }));

    if (page === 1) patchCache({ bulletins });
    return { ok: true, bulletins, total: count ?? 0, page, limit };
  } catch {
    const cached = getCache();
    if (cached?.bulletins) {
      return {
        ok: true,
        bulletins: cached.bulletins,
        total: cached.bulletins.length,
        page: 1,
        limit: 20,
        fromCache: true,
      };
    }
    throwApi('NETWORK_ERROR', '网络错误');
  }
}

export async function postBulletin(title: string, content: string): Promise<ApiSuccess> {
  const myFaction = await supabase.rpc('get_my_faction_id' as never);
  const myName = await supabase.rpc('get_my_company_name' as never);
  const { error } = await supabase.from('bulletins').insert({
    faction_id: (myFaction.data as string) ?? '',
    title,
    content,
    author: (myName.data as string) ?? '',
  });
  if (error) throwApi('CREATE_FAILED', error.message);
  return { ok: true };
}

// --- Transport ---

export async function fetchTransportRoutes(): Promise<TransportRoutesResponse> {
  const [routesResult, membersResult] = await Promise.all([
    supabase.from('transport_routes').select('*').order('created_at', { ascending: false }),
    supabase.from('members').select('company_name, username'),
  ]);
  if (routesResult.error) throwApi('FETCH_FAILED', routesResult.error.message);

  const usernameMap: Record<string, string> = {};
  for (const m of membersResult.data ?? []) {
    if (m.username) usernameMap[m.company_name] = m.username;
  }

  const routes: TransportRoute[] = (routesResult.data ?? []).map(r => ({
    id: r.id,
    companyName: r.company_name,
    username: usernameMap[r.company_name],
    departure: r.departure,
    destination: r.destination,
    roundTrip: r.round_trip,
    feePerTon: r.fee_per_ton,
    feePerM3: r.fee_per_m3,
    shipRegistrations: r.ship_registration ? r.ship_registration.split(',').filter(Boolean) : [],
    notes: r.notes ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
  return { ok: true, routes };
}

export async function createTransportRoute(data: {
  departure: string;
  destination: string;
  roundTrip: boolean;
  feePerTon: number;
  feePerM3: number;
  shipRegistrations: string[];
  notes?: string;
}): Promise<ApiSuccess> {
  const myFaction = await supabase.rpc('get_my_faction_id' as never);
  const myName = await supabase.rpc('get_my_company_name' as never);
  const { error } = await supabase.from('transport_routes').insert({
    faction_id: (myFaction.data as string) ?? '',
    company_name: (myName.data as string) ?? '',
    departure: data.departure,
    destination: data.destination,
    round_trip: data.roundTrip,
    fee_per_ton: data.feePerTon,
    fee_per_m3: data.feePerM3,
    ship_registration: data.shipRegistrations.length > 0 ? data.shipRegistrations.join(',') : null,
    notes: data.notes ?? null,
  });
  if (error) throwApi('CREATE_FAILED', error.message);
  return { ok: true };
}

export async function updateTransportRoute(
  id: string,
  data: {
    departure: string;
    destination: string;
    roundTrip: boolean;
    feePerTon: number;
    feePerM3: number;
    shipRegistrations: string[];
    notes?: string;
  },
): Promise<ApiSuccess> {
  const { error } = await supabase
    .from('transport_routes')
    .update({
      departure: data.departure,
      destination: data.destination,
      round_trip: data.roundTrip,
      fee_per_ton: data.feePerTon,
      fee_per_m3: data.feePerM3,
      ship_registration:
        data.shipRegistrations.length > 0 ? data.shipRegistrations.join(',') : null,
      notes: data.notes ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id);
  if (error) throwApi('UPDATE_FAILED', error.message);
  return { ok: true };
}

export async function deleteTransportRoute(id: string): Promise<ApiSuccess> {
  const { error } = await supabase.from('transport_routes').delete().eq('id', id);
  if (error) throwApi('DELETE_FAILED', error.message);
  return { ok: true };
}

// --- Ship Status ---

export async function reportShipStatuses(
  reports: Omit<ShipStatusReport, 'reportedAt'>[],
): Promise<ApiSuccess> {
  if (reports.length === 0) return { ok: true };

  const myFaction = await supabase.rpc('get_my_faction_id' as never);
  const factionId = (myFaction.data as string) ?? '';
  const now = new Date().toISOString();

  const rows = reports.map(r => {
    const row: Record<string, unknown> = {
      faction_id: factionId,
      company_name: r.companyName,
      ship_registration: r.shipRegistration,
      ship_name: r.shipName ?? null,
      condition: r.condition ?? null,
      location: r.location ?? null,
      is_flying: r.isFlying,
      flight_destination: r.flightDestination ?? null,
      flight_eta: r.flightEta ?? null,
      cargo_volume: r.cargoVolume ?? null,
      cargo_weight: r.cargoWeight ?? null,
      reported_at: now,
    };
    if (r.manualStatus !== undefined) {
      row.manual_status = r.manualStatus;
    }
    return row;
  });

  const { error } = await supabase.from('ship_status_reports').upsert(rows, {
    onConflict: 'faction_id,company_name,ship_registration',
  });
  if (error) throwApi('REPORT_FAILED', error.message);
  return { ok: true };
}

export async function fetchShipStatuses(): Promise<ShipStatusResponse> {
  const { data, error } = await supabase
    .from('ship_status_reports')
    .select('*')
    .order('company_name');
  if (error) throwApi('FETCH_FAILED', error.message);

  const reports: ShipStatusReport[] = (data ?? []).map(r => ({
    companyName: r.company_name,
    shipRegistration: r.ship_registration,
    shipName: r.ship_name ?? undefined,
    condition: r.condition ?? undefined,
    location: r.location ?? undefined,
    isFlying: r.is_flying,
    manualStatus: r.manual_status ?? undefined,
    flightDestination: r.flight_destination ?? undefined,
    flightEta: r.flight_eta ?? undefined,
    cargoVolume: r.cargo_volume ?? undefined,
    cargoWeight: r.cargo_weight ?? undefined,
    reportedAt: r.reported_at,
  }));
  return { ok: true, reports };
}

export async function updateShipManualStatus(
  shipRegistration: string,
  manualStatus: string | null,
): Promise<ApiSuccess> {
  const myFaction = await supabase.rpc('get_my_faction_id' as never);
  const myName = await supabase.rpc('get_my_company_name' as never);
  const { error } = await supabase
    .from('ship_status_reports')
    .update({ manual_status: manualStatus })
    .eq('faction_id', (myFaction.data as string) ?? '')
    .eq('company_name', (myName.data as string) ?? '')
    .eq('ship_registration', shipRegistration);
  if (error) throwApi('UPDATE_FAILED', error.message);
  return { ok: true };
}

// --- Transport Trips & Bookings ---

export async function fetchTripsForRoute(routeId: string): Promise<TripsResponse> {
  const [tripsResult, bookingsResult, membersResult] = await Promise.all([
    supabase
      .from('transport_trips')
      .select('*')
      .eq('route_id', routeId)
      .in('status', ['open'])
      .order('departure_time', { ascending: true }),
    supabase.from('transport_bookings').select('*').order('created_at', { ascending: true }),
    supabase.from('members').select('company_name, username'),
  ]);
  if (tripsResult.error) throwApi('FETCH_FAILED', tripsResult.error.message);

  const usernameMap: Record<string, string> = {};
  for (const m of membersResult.data ?? []) {
    if (m.username) usernameMap[m.company_name] = m.username;
  }

  const bookingsByTrip: Record<string, TransportBooking[]> = {};
  for (const b of bookingsResult.data ?? []) {
    const booking: TransportBooking = {
      id: b.id,
      tripId: b.trip_id,
      companyName: b.company_name,
      username: usernameMap[b.company_name],
      volume: b.volume,
      weight: b.weight,
      cargoDescription: b.cargo_description ?? undefined,
      createdAt: b.created_at,
    };
    (bookingsByTrip[b.trip_id] ??= []).push(booking);
  }

  const trips: TransportTrip[] = (tripsResult.data ?? []).map(t => ({
    id: t.id,
    routeId: t.route_id,
    companyName: t.company_name,
    username: usernameMap[t.company_name],
    departureTime: t.departure_time,
    availableVolume: t.available_volume,
    availableWeight: t.available_weight,
    description: t.description ?? undefined,
    status: t.status as TransportTrip['status'],
    bookings: bookingsByTrip[t.id] ?? [],
    createdAt: t.created_at,
  }));
  return { ok: true, trips };
}

export async function createTrip(
  routeId: string,
  data: {
    departureTime: string;
    availableVolume: number;
    availableWeight: number;
    description?: string;
  },
): Promise<ApiSuccess> {
  const myFaction = await supabase.rpc('get_my_faction_id' as never);
  const myName = await supabase.rpc('get_my_company_name' as never);
  const { error } = await supabase.from('transport_trips').insert({
    faction_id: (myFaction.data as string) ?? '',
    route_id: routeId,
    company_name: (myName.data as string) ?? '',
    departure_time: data.departureTime,
    available_volume: data.availableVolume,
    available_weight: data.availableWeight,
    description: data.description ?? null,
  });
  if (error) throwApi('CREATE_FAILED', error.message);
  return { ok: true };
}

export async function updateTripStatus(
  tripId: string,
  status: 'closed' | 'cancelled',
): Promise<ApiSuccess> {
  const { error } = await supabase.from('transport_trips').update({ status }).eq('id', tripId);
  if (error) throwApi('UPDATE_FAILED', error.message);
  return { ok: true };
}

export async function createBooking(
  tripId: string,
  data: { volume: number; weight: number; cargoDescription?: string },
): Promise<ApiSuccess> {
  const myFaction = await supabase.rpc('get_my_faction_id' as never);
  const myName = await supabase.rpc('get_my_company_name' as never);
  const { error } = await supabase.from('transport_bookings').insert({
    faction_id: (myFaction.data as string) ?? '',
    trip_id: tripId,
    company_name: (myName.data as string) ?? '',
    volume: data.volume,
    weight: data.weight,
    cargo_description: data.cargoDescription ?? null,
  });
  if (error) throwApi('CREATE_FAILED', error.message);
  return { ok: true };
}

export async function deleteBooking(bookingId: string): Promise<ApiSuccess> {
  const { error } = await supabase.from('transport_bookings').delete().eq('id', bookingId);
  if (error) throwApi('DELETE_FAILED', error.message);
  return { ok: true };
}

// --- Plugin Users ---

export async function fetchMyRole(): Promise<MemberRole> {
  const { data: userDataResult, error: userError } = await supabase.auth.getUser();
  if (userError !== null || userDataResult.user === null) {
    throwApi('UNAUTHORIZED', '请先登录组织面板');
  }

  const { data, error } = await supabase
    .from('members')
    .select('role')
    .eq('auth_uid', userDataResult.user.id)
    .single();
  if (error !== null || data === null) {
    throwApi('UNAUTHORIZED', '未找到组织成员信息，请重新登录组织面板');
  }

  const role = data.role as MemberRole;
  if (role !== 'member' && role !== 'partner' && role !== 'executive') {
    throwApi('INVALID_ROLE', '组织角色无效');
  }

  return role;
}

export async function reportPluginUser(username: string, companyName: string): Promise<ApiSuccess> {
  const { error } = await supabase.from('plugin_users').upsert(
    {
      username,
      company_name: companyName,
      last_active: new Date().toISOString(),
    },
    { onConflict: 'username' },
  );
  if (error) throwApi('REPORT_FAILED', error.message);
  return { ok: true };
}

export async function fetchPluginUsers(): Promise<PluginUsersResponse> {
  const role = await fetchMyRole();
  if (role !== 'executive') {
    throwApi('INSUFFICIENT_PERMISSION', '只有 executive 可以查看插件用户统计');
  }

  const { data, error } = await supabase
    .from('plugin_users')
    .select('*')
    .order('last_active', { ascending: false });
  if (error) throwApi('FETCH_FAILED', error.message);

  const users: PluginUser[] = (data ?? []).map(r => ({
    username: r.username,
    companyName: r.company_name,
    lastActive: r.last_active,
  }));
  return { ok: true, users };
}
