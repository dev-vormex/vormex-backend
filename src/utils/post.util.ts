import axios from 'axios';
import { parseStoredMusicAttachment, type StoredMusicAttachment } from './music.util';

type JsonRecord = Record<string, unknown>;

export interface StoredPollOption {
  id: string;
  text: string;
  votes: number;
}

export interface StoredPostMetadata {
  mentions?: string[];
  music?: StoredMusicAttachment | null;
  contentType?: string;
  videoUrl?: string | null;
  videoThumbnail?: string | null;
  videoDuration?: number | null;
  videoSize?: number | null;
  videoFormat?: string | null;
  documentUrl?: string | null;
  documentName?: string | null;
  documentType?: string | null;
  documentSize?: number | null;
  documentPages?: number | null;
  documentThumbnail?: string | null;
  linkUrl?: string | null;
  linkTitle?: string | null;
  linkDescription?: string | null;
  linkImage?: string | null;
  linkDomain?: string | null;
  articleTitle?: string | null;
  articleCoverImage?: string | null;
  articleReadTime?: number | null;
  articleTags?: string[];
  pollDuration?: number | null;
  pollEndsAt?: string | null;
  pollOptions?: StoredPollOption[];
  showResultsBeforeVote?: boolean;
  celebrationType?: string | null;
  celebrationMeta?: JsonRecord | null;
  celebrationBadge?: string | null;
  /** CDN URL for user-selected celebration GIF (from uploaded image/gif) */
  celebrationGifUrl?: string | null;
}

const DEFAULT_CONTENT_TYPE = 'text/plain';

function asRecord(value: unknown): JsonRecord {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as JsonRecord;
  }
  return {};
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return fallback;
}

export function parseStringArrayField(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => asTrimmedString(item))
      .filter((item): item is string => Boolean(item));
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];

    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parseStringArrayField(parsed);
      }
    } catch {
      // Fall back to treating the value as a single string entry.
    }

    return [trimmed];
  }

  return [];
}

export function parseBooleanField(value: unknown, fallback = false): boolean {
  return asBoolean(value, fallback);
}

export function parseNumberField(value: unknown): number | null {
  return asNumber(value);
}

export function normalizeUrl(value: unknown): string | null {
  const raw = asTrimmedString(value);
  if (!raw) return null;

  if (/^https?:\/\//i.test(raw)) {
    return raw;
  }

  if (/^[a-z0-9.-]+\.[a-z]{2,}(\/.*)?$/i.test(raw)) {
    return `https://${raw}`;
  }

  return raw;
}

export function extractDomain(url: string | null | undefined): string | null {
  if (!url) return null;

  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

export function mapPostTypeToFrontend(type: string): string {
  const normalized = type.toLowerCase();
  switch (normalized) {
    case 'image':
      return 'IMAGE';
    case 'video':
      return 'VIDEO';
    case 'link':
      return 'LINK';
    case 'poll':
      return 'POLL';
    case 'article':
      return 'ARTICLE';
    case 'celebration':
      return 'CELEBRATION';
    case 'document':
      return 'DOCUMENT';
    case 'mixed':
      return 'MIXED';
    default:
      return 'TEXT';
  }
}

export function mapVisibilityToFrontend(visibility: string): string {
  const normalized = visibility.toLowerCase();
  if (normalized === 'connections') return 'CONNECTIONS';
  if (normalized === 'private') return 'PRIVATE';
  return 'PUBLIC';
}

export function parseVisibility(value?: string): string {
  const normalized = (value || 'PUBLIC').toUpperCase();
  if (normalized === 'CONNECTIONS') return 'connections';
  if (normalized === 'PRIVATE') return 'private';
  return 'public';
}

export function getPostMetadata(value: unknown): StoredPostMetadata {
  const metadata = asRecord(value);

  const celebrationMetaValue = metadata.celebrationMeta;
  const celebrationMeta =
    celebrationMetaValue && typeof celebrationMetaValue === 'object' && !Array.isArray(celebrationMetaValue)
      ? (celebrationMetaValue as JsonRecord)
      : null;

  const rawPollOptions = Array.isArray(metadata.pollOptions) ? metadata.pollOptions : [];
  const pollOptions = rawPollOptions
    .map((option, index) => {
      const item = asRecord(option);
      const id = asTrimmedString(item.id) || `option_${index + 1}`;
      const text = asTrimmedString(item.text) || `Option ${index + 1}`;
      const votes = asNumber(item.votes) ?? 0;
      return { id, text, votes: Math.max(0, votes) };
    })
    .filter((option) => option.text.length > 0);

  return {
    mentions: parseStringArrayField(metadata.mentions),
    music: parseStoredMusicAttachment(metadata.music),
    contentType: asTrimmedString(metadata.contentType) || DEFAULT_CONTENT_TYPE,
    videoUrl: normalizeUrl(metadata.videoUrl),
    videoThumbnail: normalizeUrl(metadata.videoThumbnail),
    videoDuration: asNumber(metadata.videoDuration),
    videoSize: asNumber(metadata.videoSize),
    videoFormat: asTrimmedString(metadata.videoFormat),
    documentUrl: normalizeUrl(metadata.documentUrl),
    documentName: asTrimmedString(metadata.documentName),
    documentType: asTrimmedString(metadata.documentType),
    documentSize: asNumber(metadata.documentSize),
    documentPages: asNumber(metadata.documentPages),
    documentThumbnail: normalizeUrl(metadata.documentThumbnail),
    linkUrl: normalizeUrl(metadata.linkUrl),
    linkTitle: asTrimmedString(metadata.linkTitle),
    linkDescription: asTrimmedString(metadata.linkDescription),
    linkImage: normalizeUrl(metadata.linkImage),
    linkDomain: asTrimmedString(metadata.linkDomain),
    articleTitle: asTrimmedString(metadata.articleTitle),
    articleCoverImage: normalizeUrl(metadata.articleCoverImage),
    articleReadTime: asNumber(metadata.articleReadTime),
    articleTags: parseStringArrayField(metadata.articleTags),
    pollDuration: asNumber(metadata.pollDuration),
    pollEndsAt: asTrimmedString(metadata.pollEndsAt),
    pollOptions,
    showResultsBeforeVote: asBoolean(metadata.showResultsBeforeVote, false),
    celebrationType: asTrimmedString(metadata.celebrationType),
    celebrationMeta,
    celebrationBadge: asTrimmedString(metadata.celebrationBadge),
    celebrationGifUrl: normalizeUrl(metadata.celebrationGifUrl),
  };
}

function decodeBasicHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function pickTitleFromHtml(html: string): string | null {
  const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return m?.[1] ? decodeBasicHtmlEntities(m[1].trim()) : null;
}

/**
 * Best-effort Open Graph fetch so link posts show title, description, and image in clients.
 */
export async function enrichLinkMetadataFromUrl(metadata: StoredPostMetadata): Promise<void> {
  const url = metadata.linkUrl;
  if (!url) return;

  try {
    const res = await axios.get<string>(url, {
      timeout: 9000,
      maxRedirects: 5,
      responseType: 'text',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; VormexBot/1.0)',
        Accept: 'text/html,application/xhtml+xml',
      },
      validateStatus: (s) => s >= 200 && s < 400,
    });
    const html = typeof res.data === 'string' ? res.data : '';
    const pickOg = (prop: string): string | null => {
      const re1 = new RegExp(
        `<meta[^>]+property=["']og:${prop}["'][^>]+content=["']([^"']+)["']`,
        'i',
      );
      const re2 = new RegExp(
        `<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:${prop}["']`,
        'i',
      );
      let m = html.match(re1) || html.match(re2);
      return m?.[1] ? decodeBasicHtmlEntities(m[1]) : null;
    };
    const pickName = (name: string): string | null => {
      const re1 = new RegExp(`<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']+)["']`, 'i');
      const re2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${name}["']`, 'i');
      let m = html.match(re1) || html.match(re2);
      return m?.[1] ? decodeBasicHtmlEntities(m[1]) : null;
    };

    const domainFallback = metadata.linkDomain || extractDomain(url);
    const titleLooksWeak =
      !metadata.linkTitle ||
      metadata.linkTitle === domainFallback ||
      metadata.linkTitle === url;

    if (titleLooksWeak) {
      const t = pickOg('title') || pickName('twitter:title') || pickTitleFromHtml(html);
      if (t) metadata.linkTitle = t;
    }
    if (!metadata.linkDescription) {
      const d = pickOg('description') || pickName('description') || pickName('twitter:description');
      if (d) metadata.linkDescription = d;
    }
    if (!metadata.linkImage) {
      const img = pickOg('image') || pickName('twitter:image');
      const normalized = normalizeUrl(img);
      if (normalized) metadata.linkImage = normalized;
    }
    if (!metadata.linkDomain) {
      metadata.linkDomain = extractDomain(url);
    }
  } catch {
    /* keep client-side preview only */
  }
}

export function mapPollOptionsForResponse(
  options: StoredPollOption[],
  userVotedOptionId: string | null
): Array<StoredPollOption & { hasVoted: boolean; percentage: number }> {
  const totalVotes = options.reduce((sum, option) => sum + Math.max(0, option.votes), 0);

  return options.map((option) => ({
    ...option,
    hasVoted: option.id === userVotedOptionId,
    percentage: totalVotes > 0 ? Math.round((option.votes / totalVotes) * 100) : 0,
  }));
}

export function mapPostResponse(post: any, currentUserId: string) {
  const metadata = getPostMetadata(post.metadata);
  const mediaUrls = Array.isArray(post.mediaUrls) ? post.mediaUrls.filter(Boolean) : [];
  const normalizedType = (post.type || 'text').toLowerCase();
  const isVideo = normalizedType === 'video';
  const isDocument = normalizedType === 'document';
  const isSaved = Boolean(post.saved_posts?.some((saved: any) => saved.userId === currentUserId));
  const savesCount = post._count?.saved_posts ?? post.saved_posts?.length ?? 0;
  const userVotedOptionId =
    post.pollVotes?.find?.((vote: any) => vote.userId === currentUserId)?.optionId ?? null;
  const pollOptions = mapPollOptionsForResponse(metadata.pollOptions || [], userVotedOptionId);

  const videoUrl = metadata.videoUrl || (isVideo && mediaUrls.length > 0 ? mediaUrls[0] : null);
  const videoThumbnail = metadata.videoThumbnail || (isVideo && mediaUrls.length > 0 ? mediaUrls[0] : null);
  const documentUrl = metadata.documentUrl || (isDocument && mediaUrls.length > 0 ? mediaUrls[0] : null);
  const linkUrl = metadata.linkUrl || null;

  return {
    id: post.id,
    kind: 'POST',
    type: mapPostTypeToFrontend(post.type),
    authorId: post.authorId,
    author: {
      id: post.author.id,
      username: post.author.username,
      name: post.author.name,
      profileImage: post.author.profileImage,
      headline: post.author.headline,
    },
    content: post.content,
    contentType: metadata.contentType || DEFAULT_CONTENT_TYPE,
    mentions: metadata.mentions || [],
    music: metadata.music ?? null,
    mediaUrls,
    mediaCount: mediaUrls.length,
    videoUrl,
    videoThumbnail,
    videoDuration: metadata.videoDuration ?? null,
    videoSize: metadata.videoSize ?? null,
    videoFormat: metadata.videoFormat ?? null,
    documentUrl,
    documentName: metadata.documentName ?? null,
    documentType: metadata.documentType ?? null,
    documentSize: metadata.documentSize ?? null,
    documentPages: metadata.documentPages ?? null,
    documentThumbnail: metadata.documentThumbnail ?? null,
    linkUrl,
    linkTitle: metadata.linkTitle ?? metadata.linkDomain ?? null,
    linkDescription: metadata.linkDescription ?? null,
    linkImage: metadata.linkImage ?? null,
    linkDomain: metadata.linkDomain ?? extractDomain(linkUrl),
    articleTitle: metadata.articleTitle ?? null,
    articleCoverImage: metadata.articleCoverImage ?? mediaUrls[0] ?? null,
    articleReadTime: metadata.articleReadTime ?? null,
    articleTags: metadata.articleTags || [],
    pollDuration: metadata.pollDuration ?? null,
    pollEndsAt: metadata.pollEndsAt ?? null,
    pollOptions,
    userVotedOptionId,
    showResultsBeforeVote: metadata.showResultsBeforeVote ?? false,
    celebrationType: metadata.celebrationType ?? null,
    celebrationMeta: metadata.celebrationMeta ?? null,
    celebrationBadge: metadata.celebrationBadge ?? null,
    celebrationGifUrl: metadata.celebrationGifUrl ?? null,
    visibility: mapVisibilityToFrontend(post.visibility),
    likesCount: post.likesCount || 0,
    commentsCount: post.commentsCount || 0,
    sharesCount: post.sharesCount || 0,
    savesCount,
    isLiked: Boolean(post.likes?.some((like: any) => like.userId === currentUserId)),
    isSaved,
    userReactionType: null,
    reactionSummary: [],
    createdAt: post.createdAt,
    updatedAt: post.updatedAt,
  };
}
