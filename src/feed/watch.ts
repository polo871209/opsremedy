import { sendCard, replyMessage } from "../lark/client.ts";
import type { FeedPostStore } from "../session/store.ts";
import { log } from "../utils/logger.ts";
import { startThreatAssessment } from "./assess.ts";
import { cveIds, feedCard } from "./card.ts";
import { highestCvss } from "./cvss.ts";
import { parseRss, type FeedItem } from "./rss.ts";

export interface FeedSubscription {
  url: string;
  chatId: string;
}

const POLL_CRON = "*/15 * * * *";
const MAX_ITEM_AGE_MS = 7 * 24 * 3600_000;

async function assessOnce(threadKey: string, feedTitle: string, item: FeedItem): Promise<void> {
  try {
    if (await startThreatAssessment(threadKey, feedTitle, item))
      log.info("threat assessment started", { root: threadKey, guid: item.guid });
  } catch (e) {
    log.error("threat assessment start failed", e, { root: threadKey, guid: item.guid });
  }
}

async function pollFeed(sub: FeedSubscription, posts: FeedPostStore): Promise<void> {
  const res = await fetch(sub.url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`feed ${sub.url}: HTTP ${res.status}`);
  const feed = parseRss(await res.text());
  const cutoff = Date.now() - MAX_ITEM_AGE_MS;
  const fresh = feed.items.filter((i) => !(i.publishedAt < cutoff)).sort((a, b) => a.publishedAt - b.publishedAt);
  for (const item of fresh) {
    const key = `${sub.chatId}:${item.link || item.guid}`;
    const prior = await posts.get(key);
    if (prior?.guid === item.guid) {
      await assessOnce(prior.rootMsgId, feed.title, item);
      continue;
    }
    const card = feedCard(feed.title, item, Boolean(prior), await highestCvss(cveIds(item)));
    try {
      const rootMsgId = prior ? prior.rootMsgId : await sendCard(sub.chatId, card);
      if (prior) await replyMessage(prior.rootMsgId, { card });
      await posts.set(key, { guid: item.guid, rootMsgId });
      log.info("feed item posted", { feed: sub.url, guid: item.guid, update: Boolean(prior) });
      await assessOnce(rootMsgId, feed.title, item);
    } catch (e) {
      log.error("feed item post failed", e, { feed: sub.url, guid: item.guid });
    }
  }
}

/** Posts each new feed item to its chat. A later item with the same link replies in the first post's thread. */
export function startFeeds(subs: FeedSubscription[], posts: FeedPostStore): void {
  if (!subs.length) return;
  const pollAll = async () => {
    for (const sub of subs) {
      try {
        await pollFeed(sub, posts);
      } catch (e) {
        log.error("feed poll failed", e, { feed: sub.url });
      }
    }
  };
  log.info("feed polling scheduled", { cron: POLL_CRON, feeds: subs.map((s) => s.url) });
  Bun.cron(POLL_CRON, pollAll);
  void pollAll();
}
