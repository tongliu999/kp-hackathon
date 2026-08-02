const REQUIRED_ARRAYS = [
  "attempts",
  "fileChanges",
  "emails",
  "conversations",
  "metrics",
  "lessons",
];

export class VersionHistoryValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "VersionHistoryValidationError";
  }
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new VersionHistoryValidationError(`${label} must be a non-empty string`);
  }
}

export function validateVersionHistory(document) {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new VersionHistoryValidationError("version history must be an object");
  }
  if (document.schemaVersion !== 1) {
    throw new VersionHistoryValidationError("schemaVersion must be 1");
  }
  requireString(document.title, "title");
  if (!Array.isArray(document.nodes) || document.nodes.length === 0) {
    throw new VersionHistoryValidationError("nodes must be a non-empty array");
  }

  const byId = new Map();
  for (const [index, node] of document.nodes.entries()) {
    const label = `nodes[${index}]`;
    for (const field of ["id", "name", "strategy", "summary", "status", "actor", "createdAt"]) {
      requireString(node?.[field], `${label}.${field}`);
    }
    if (byId.has(node.id)) {
      throw new VersionHistoryValidationError(`duplicate node id: ${node.id}`);
    }
    if (node.parentId !== null && typeof node.parentId !== "string") {
      throw new VersionHistoryValidationError(`${label}.parentId must be a string or null`);
    }
    if (!Number.isFinite(node.durationMinutes) || node.durationMinutes < 0) {
      throw new VersionHistoryValidationError(`${label}.durationMinutes must be non-negative`);
    }
    for (const field of REQUIRED_ARRAYS) {
      if (!Array.isArray(node[field])) {
        throw new VersionHistoryValidationError(`${label}.${field} must be an array`);
      }
    }
    if (!node.moneySpent || typeof node.moneySpent !== "object") {
      throw new VersionHistoryValidationError(`${label}.moneySpent must be an object`);
    }
    if (!Number.isFinite(node.moneySpent.amount) || node.moneySpent.amount < 0) {
      throw new VersionHistoryValidationError(`${label}.moneySpent.amount must be non-negative`);
    }
    requireString(node.moneySpent.currency, `${label}.moneySpent.currency`);
    if (!Array.isArray(node.moneySpent.breakdown)) {
      throw new VersionHistoryValidationError(`${label}.moneySpent.breakdown must be an array`);
    }
    byId.set(node.id, node);
  }

  const roots = document.nodes.filter((node) => node.parentId === null);
  if (roots.length !== 1) {
    throw new VersionHistoryValidationError("version history must have exactly one root");
  }
  for (const node of document.nodes) {
    if (node.parentId !== null && !byId.has(node.parentId)) {
      throw new VersionHistoryValidationError(`unknown parent ${node.parentId} for ${node.id}`);
    }
    const seen = new Set([node.id]);
    let cursor = node;
    while (cursor.parentId !== null) {
      if (seen.has(cursor.parentId)) {
        throw new VersionHistoryValidationError(`cycle detected at ${node.id}`);
      }
      seen.add(cursor.parentId);
      cursor = byId.get(cursor.parentId);
    }
  }
  return document;
}

export function indexVersionHistory(document) {
  validateVersionHistory(document);
  const byId = new Map(document.nodes.map((node) => [node.id, node]));
  const children = new Map(document.nodes.map((node) => [node.id, []]));
  for (const node of document.nodes) {
    if (node.parentId !== null) children.get(node.parentId).push(node);
  }
  return {
    document,
    byId,
    children,
    root: document.nodes.find((node) => node.parentId === null),
  };
}
