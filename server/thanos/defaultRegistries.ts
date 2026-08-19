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

export type ThanosWorkspaceSource =
  | PastoralWorkspaceSource
  | SyntheticWorkspaceSource;

export const thanosWorkspaceRegistry =
  new WorkspaceRegistry<ThanosWorkspaceSource>([
    pastoralWorkspaceDefinition,
    syntheticWorkspaceDefinition,
  ]);
export const thanosSkillRegistry = new SkillRegistry([
  pastoralSkillDefinition,
  syntheticSkillDefinition,
  syntheticWriteSkillDefinition,
]);
