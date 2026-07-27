// src/infrastructure/org-api/listings.ts
// 市场挂单 API 客户端（与任务解耦）。
//   - listListings：浏览市场 / 我的发布
//   - getListing：单条挂单详情
//   - createListing：发布挂单
//   - claimListing：接取挂单 → 扣 remaining + 创建 task
//   - cancelListing：取消挂单
import { request } from './client';
import type { OrgListing, ListingType, ListListingsResult, ClaimListingResult } from './types';

export interface ListListingsParams {
  commodity?: string;
  type?: ListingType;
  // 'market'（默认）：公开市场（status=OPEN）
  // 'mine'：当前用户发布的所有挂单（含 CLOSED/CANCELLED）
  scope?: 'market' | 'mine';
  limit?: number;
}

export async function listListings(params: ListListingsParams = {}): Promise<OrgListing[]> {
  const query: Record<string, string> = {};
  if (params.commodity) query.commodity = params.commodity;
  if (params.type) query.type = params.type;
  if (params.scope) query.scope = params.scope;
  if (params.limit !== undefined) query.limit = String(params.limit);
  const qs = new URLSearchParams(query).toString();
  const path = `/listings${qs ? `?${qs}` : ''}`;
  const result = await request<ListListingsResult>(path);
  return result.items;
}

export async function getListing(listingId: string): Promise<OrgListing> {
  return request<OrgListing>(`/listings/${listingId}`);
}

export interface CreateListingParams {
  type: ListingType;
  commodity: string;
  amount: number;
  price: number;
  currency: string;
  location?: string;
  origin?: string;
  destination?: string;
  expiresAt?: string;
}

export async function createListing(params: CreateListingParams): Promise<OrgListing> {
  return request<OrgListing>('/listings', { method: 'POST', body: params });
}

export interface ClaimListingParams {
  amount: number;
}

// claim 返回 { task, listing }：task 是新创建的反向合同载体，listing 扣减后的最新快照。
export async function claimListing(listingId: string, amount: number): Promise<ClaimListingResult> {
  return request<ClaimListingResult>(`/listings/${listingId}/claim`, {
    method: 'POST',
    body: { amount } as ClaimListingParams,
  });
}

export async function cancelListing(listingId: string): Promise<OrgListing> {
  return request<OrgListing>(`/listings/${listingId}/cancel`, { method: 'POST' });
}
