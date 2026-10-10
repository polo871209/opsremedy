import { Kafka, logLevel, type Admin, type logCreator } from "kafkajs";
import { Type } from "@earendil-works/pi-ai";
import type { SreTool } from "./types.ts";
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
  return {
    name: "kafka_list_groups",
    cheap: true,
    retry: true,
    description:
      "List consumer group ids known to the cluster. Use it to pin the exact id before kafka_describe_group — an alert label is often close but not identical.",
    parameters: Type.Object({}),
    execute: guarded(async () => {
      const r = await withAdmin(kafka, (a) => a.listGroups());
      return textResult({ count: r.groups.length, groups: r.groups });
    }),
  };
}

function describeGroupTool(kafka: Kafka): SreTool {
  return {
    name: "kafka_describe_group",
    cheap: false,
    retry: true,
    description:
      "Consumer group health: state, members (clientId/clientHost), and per-topic-partition committedOffset vs. high/low watermark with lag. " +
      "state=Empty or Dead with 0 members is the 'Kafka Consumer Group No Members' alert condition. " +
      "Lag WITH members present means the worker is slow or stuck, not absent — pivot to k8s_get_pods / k8s_pod_logs on the mapped Deployment. " +
      "One call is a point-in-time snapshot: for whether lag is GROWING, or whether the topic is still being produced to, " +
      "run promql_range over kafka_consumergroup_lag / kafka_consumergroup_current_offset_sum (labels: consumergroup, topic).",
    parameters: Type.Object({
      groupId: Type.String(),
    }),
    execute: guarded(async (args) => {
      const { groupId } = args as { groupId: string };
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
  };
}

function listTopicsTool(kafka: Kafka): SreTool {
  return {
    name: "kafka_list_topics",
    cheap: true,
    retry: true,
    description: "List topic names. Use it to pin the exact topic before kafka_describe_topic.",
    parameters: Type.Object({}),
    execute: guarded(async () => {
      const topics = await withAdmin(kafka, (a) => a.listTopics());
      return textResult({ count: topics.length, topics });
    }),
  };
}

function describeTopicTool(kafka: Kafka): SreTool {
  return {
    name: "kafka_describe_topic",
    cheap: false,
    retry: true,
    description:
      "Topic metadata: partitionCount, and per-partition leader/replicas/isr. " +
      "underReplicated=true (isr shorter than replicas) is the fault signal — a replica broker is down or lagging, independent of consumer lag. " +
      "A short replicas list is NOT a fault: that is the replication factor the topic was created with. " +
      "Read partitionCount against kafka_describe_group's member count to tell 'too few partitions to parallelize' apart from 'workers are slow or stuck'.",
    parameters: Type.Object({
      topic: Type.String(),
    }),
    execute: guarded(async (args) => {
      const { topic } = args as { topic: string };
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
  };
}

export function kafkaTools(brokers: string[]): SreTool[] {
  const kafka = new Kafka({ clientId: "opsremedy", brokers, retry: { retries: 2 }, logCreator: kafkaLogCreator });
  return [listGroupsTool(kafka), describeGroupTool(kafka), listTopicsTool(kafka), describeTopicTool(kafka)];
}
