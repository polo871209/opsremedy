import type { Config } from "./config.ts";
import type {
  IncidentStore,
  IncidentMetaStore,
  AlertGroupStore,
  KVStore,
} from "./session/store.ts";
import type { ThreadItem } from "./lark/client.ts";

interface State {
  cfg: Config;
  incidents: IncidentStore;
  incidentMeta: IncidentMetaStore;
  alertGroups: AlertGroupStore;
  threadMessages: KVStore<ThreadItem[]>;
  botOpenId: string;
}

let _state: State | undefined;

export function initState(s: State): void {
  _state = s;
}

export function state(): State {
  if (!_state) throw new Error("state not initialized");
  return _state;
}

export function setBotOpenId(botOpenId: string): void {
  if (_state) _state.botOpenId = botOpenId;
}
