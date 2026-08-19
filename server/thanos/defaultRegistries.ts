import { SkillRegistry } from "./skillRegistry";
import { WorkspaceRegistry } from "./workspaceRegistry";
import {
  pastoralSkillDefinition,
  pastoralWorkspaceDefinition,
  type PastoralWorkspaceSource,
} from "../workspaces/pastoral/workspaceDefinition";
import {
  syntheticSkillDefinition,
  syntheticWriteSkillDefinition,
  syntheticWorkspaceDefinition,
  type SyntheticWorkspaceSource,
} from "../workspaces/synthetic/workspaceDefinition";
import {
  jmgSkillDefinition,
  jmgWorkspaceDefinition,
  type JmgWorkspaceSource,
} from "../workspaces/jmg/workspaceDefinition";

export type ThanosWorkspaceSource =
  | PastoralWorkspaceSource
  | SyntheticWorkspaceSource
  | JmgWorkspaceSource;

export const thanosWorkspaceRegistry =
  new WorkspaceRegistry<ThanosWorkspaceSource>([
    pastoralWorkspaceDefinition,
    syntheticWorkspaceDefinition,
    jmgWorkspaceDefinition,
  ]);
export const thanosSkillRegistry = new SkillRegistry([
  pastoralSkillDefinition,
  syntheticSkillDefinition,
  syntheticWriteSkillDefinition,
  jmgSkillDefinition,
]);
