import { Kafka, logLevel, type Admin, type logCreator } from "kafkajs";
import { obj, str } from "@earendil-works/pi-schema";
import { sreTool, type SreTool } from "./types.ts";
import { textResult, errResult, guarded } from "./result.ts";
import { log } from "../utils/logger.ts";

const kafkaLogCreator: logCreator = () => (entry) => {
  const { level, message, ...fields } = entry.log;
  const withComponent = { component: "kafkajs", namespace: entry.namespace, ...fields };
  if (level >= logLevel.ERROR) log.error(message, undefined, withComponent);
  else if (level === logLevel.WARN) log.warn(message, withComponent);
  else if (level === logLevel.INFO) log.info(message, withComponent);
  else log.debug(message, withComponent);
};

async function withAdmin<T>(kafka: Kafka, fn: (a: Admin) => Promise<T>): Promise<T> {
  const admin = kafka.admin();
  await admin.connect();
  try {
    return await fn(admin);
  } finally {
    await admin.disconnect().catch(() => {});
  }
}

function listGroupsTool(kafka: Kafka): SreTool {
  return sreTool({
    name: "kafka_list_groups",
    cheap: true,
    retry: true,
    description:
      "List consumer group ids. An alert label can differ from the real id, so take the exact id here before kafka_describe_group.",
    parameters: obj({}),
    execute: guarded(async () => {
      const r = await withAdmin(kafka, (a) => a.listGroups());
      return textResult({ count: r.groups.length, groups: r.groups });
    }),
  });
}

function describeGroupTool(kafka: Kafka): SreTool {
  return sreTool({
    name: "kafka_describe_group",
    cheap: false,
    retry: true,
    description:
      "Snapshot of one consumer group: state, members, and committed offset, watermarks and lag per partition. " +
      "state Empty or Dead with 0 members is the 'Kafka Consumer Group No Members' condition. " +
      "Lag with members present means a slow or stuck worker, so read the pods and logs of the consuming Deployment. " +
      "For the lag trend, run promql_range on kminion_kafka_consumer_group_topic_lag or kminion_kafka_consumer_group_topic_offset_sum, by group_id and topic_name. " +
      "For a stuck or memberless group, recommend a rollout restart of the consuming Deployment by a human.",
    parameters: obj({
      groupId: str(),
    }),
    execute: guarded(async ({ groupId }) => {
      const [state, offsets, watermarksByTopic] = await withAdmin(kafka, async (admin) => {
        const described = (await admin.describeGroups([groupId])).groups[0];
        const off = await admin.fetchOffsets({ groupId });
        const wm = new Map<string, { partition: number; high: string; low: string }[] | Error>();
        for (const t of off) {
          try {
            wm.set(t.topic, await admin.fetchTopicOffsets(t.topic));
          } catch (e) {
            wm.set(t.topic, e instanceof Error ? e : new Error(String(e)));
          }
        }
        return [described, off, wm] as const;
      });
      if (!state) return errResult(new Error(`group not found: ${groupId}`));

      const lagByTopic: Record<string, { error?: string; partitions: unknown[] }> = {};
      for (const t of offsets) {
        const fetched = watermarksByTopic.get(t.topic);
        const failed = fetched instanceof Error ? fetched : undefined;
        const watermarks = failed ? [] : ((fetched ?? []) as Array<{ partition: number; high: string; low: string }>);
        const watermarkError = failed?.message;
        if (failed) log.error(`kafka_describe_group: fetchTopicOffsets failed`, failed, { groupId, topic: t.topic });
        const byPartition = new Map(watermarks.map((p) => [p.partition, { high: Number(p.high), low: Number(p.low) }]));
        lagByTopic[t.topic] = {
          error: watermarkError,
          partitions: t.partitions.map((p) => {
            const committed = Number(p.offset);
            const wm = byPartition.get(p.partition);
            return {
              partition: p.partition,
              committedOffset: committed,
              highWatermark: wm?.high,
              lowWatermark: wm?.low,
              lag: committed >= 0 && wm ? wm.high - committed : undefined,
            };
          }),
        };
      }

      return textResult({
        groupId: state.groupId,
        state: state.state,
        protocol: state.protocol,
        protocolType: state.protocolType,
        memberCount: state.members.length,
        members: state.members.map((m) => ({ memberId: m.memberId, clientId: m.clientId, clientHost: m.clientHost })),
        lagByTopic,
      });
    }),
  });
}

function listTopicsTool(kafka: Kafka): SreTool {
  return sreTool({
    name: "kafka_list_topics",
    cheap: true,
    retry: true,
    description: "List topic names. Use it to pin the exact topic before kafka_describe_topic.",
    parameters: obj({}),
    execute: guarded(async () => {
      const topics = await withAdmin(kafka, (a) => a.listTopics());
      return textResult({ count: topics.length, topics });
    }),
  });
}

function describeTopicTool(kafka: Kafka): SreTool {
  return sreTool({
    name: "kafka_describe_topic",
    cheap: false,
    retry: true,
    description:
      "Topic partitions with leader, replicas and isr. underReplicated=true means a replica broker is down or behind. " +
      "A short replicas list is the replication factor of the topic, not a fault. " +
      "Compare partitionCount with the memberCount of kafka_describe_group to tell too few partitions from slow workers.",
    parameters: obj({
      topic: str(),
    }),
    execute: guarded(async ({ topic }) => {
      const { topics } = await withAdmin(kafka, (a) => a.fetchTopicMetadata({ topics: [topic] }));
      const meta = topics[0];
      if (!meta) return errResult(new Error(`topic not found: ${topic}`));
      return textResult({
        topic: meta.name,
        partitionCount: meta.partitions.length,
        partitions: meta.partitions.map((p) => ({
          partition: p.partitionId,
          leader: p.leader,
          replicas: p.replicas,
          isr: p.isr,
          underReplicated: p.isr.length < p.replicas.length,
        })),
      });
    }),
  });
}

export function kafkaTools(brokers: string[]): SreTool[] {
  const kafka = new Kafka({ clientId: "opsremedy", brokers, retry: { retries: 2 }, logCreator: kafkaLogCreator });
  return [listGroupsTool(kafka), describeGroupTool(kafka), listTopicsTool(kafka), describeTopicTool(kafka)];
}
