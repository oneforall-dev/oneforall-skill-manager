export type Silence = { start: number; end: number; duration: number };
export type TranscriptSegment = { start: number; end: number; text: string };

export type EditPlan = {
  generatedAt: string;
  strategy: string;
  keep: Array<{ start: number; end: number }>;
  cuts: Array<{ start: number; end: number; reason: string }>;
  captions: Array<{ start: number; end: number; text: string }>;
  visuals: Array<{ at: number; instruction: string }>;
  audio: { normalize: boolean; targetLufs: number };
};

export type Version = {
  version: number;
  createdAt: string;
  file: string;
  duration?: number;
  renderTimeSeconds: number;
  revision: boolean;
  feedbackApplied: string[];
};

export type Project = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  status: "created" | "analyzing" | "analyzed" | "planned" | "rendering" | "rendered" | "error";
  sourceUrl?: string;
  sourceFile?: string;
  duration?: number;
  width?: number;
  height?: number;
  fps?: number;
  codec?: string;
  audioCodec?: string;
  silences: Silence[];
  transcript: { language?: string; text: string; segments: TranscriptSegment[]; warning?: string };
  editPlan?: EditPlan;
  versions: Version[];
  latestVersion: number;
  feedback: Array<{ id: string; note: string; createdAt: string; appliedInVersion?: number }>;
  error?: string;
};

export type ContentStatus =
  | "DRAFT"
  | "IN_PRODUCTION"
  | "READY_FOR_AUDIT"
  | "APPROVED"
  | "CORRECTION_REQUIRED"
  | "REJECTED"
  | "FAILED"
  | "SUPERSEDED"
  | "DO_NOT_PUBLISH";

export type ContentVersion = {
  version: number;
  createdAt: string;
  createdBy: string;
  summary: string;
  package: Record<string, unknown>;
};

export type SpecialistCall = {
  id: string;
  specialist: string;
  action: string;
  task: string;
  context?: string;
  lockedElements: string[];
  expectedOutput: string;
  returnTo: string;
  contentVersion: number;
  status: "REQUESTED" | "COMPLETE";
  createdAt: string;
  completedAt?: string;
  result?: Record<string, unknown>;
};

export type ContentHandoff = {
  id: string;
  targetNick: string;
  targetPlugin: string;
  action: string;
  context: string;
  expectedOutput: string;
  returnTo?: string;
  attempt: number;
  approvalReceipt?: string;
  dependencies: string[];
  contentVersion: number;
  createdAt: string;
};

export type ContentItem = {
  itemId: string;
  clientId: string;
  title: string;
  format: string;
  objective?: string;
  status: ContentStatus;
  createdAt: string;
  updatedAt: string;
  currentVersion: number;
  lockedElements: string[];
  context?: string;
  versions: ContentVersion[];
  specialistCalls: SpecialistCall[];
  handoffs: ContentHandoff[];
};

export type CharacterAssetRole =
  | "FACE_LOCK"
  | "HERO_REFERENCE"
  | "CHAR_SHEET"
  | "OUTFIT"
  | "POSE"
  | "EXPRESSION"
  | "APPROVED_RENDER"
  | "REJECTED"
  | "OTHER";

export type CharacterAsset = {
  id: string;
  driveFileId: string;
  driveUrl: string;
  name: string;
  mimeType?: string;
  role: CharacterAssetRole;
  tags: string[];
  notes?: string;
  approved: boolean;
  createdAt: string;
  updatedAt: string;
};

export type CharacterCanonVersion = {
  version: number;
  createdAt: string;
  createdBy: string;
  summary: string;
  snapshot: Record<string, unknown>;
};

export type Character = {
  characterId: string;
  clientId: string;
  name: string;
  aliases: string[];
  status: "DRAFT" | "ACTIVE" | "ARCHIVED";
  canonVersion: number;
  description?: string;
  identityTraits: Record<string, unknown>;
  lockedElements: string[];
  negativeConstraints: string[];
  tags: string[];
  relationships: string[];
  driveFolderId?: string;
  driveFolderUrl?: string;
  assets: CharacterAsset[];
  versions: CharacterCanonVersion[];
  createdAt: string;
  updatedAt: string;
};
