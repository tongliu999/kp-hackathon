import { indexVersionHistory } from "/src/version_history/model.js";

const treeElement = document.querySelector("#history-tree");
const inspector = document.querySelector("#inspector");

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function money({ amount, currency }) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: amount >= 100 ? 0 : 2,
  }).format(amount);
}

function renderNode(node, history) {
  const item = element("li", "tree-item");
  const button = element("button", `version-node status-${node.status}`);
  button.type = "button";
  button.dataset.nodeId = node.id;
  button.setAttribute("aria-label", `Inspect ${node.name}: ${node.summary}`);

  const header = element("span", "node-header");
  header.append(element("span", "node-name", node.name));
  header.append(element("span", "node-status", node.status));
  button.append(header);
  button.append(element("span", "node-strategy", node.strategy));

  const metric = node.metrics[0];
  const footer = element("span", "node-footer");
  footer.append(element("span", "node-metric", metric ? `${metric.label} ${metric.value}` : "No metric"));
  footer.append(element("span", "node-spend", money(node.moneySpent)));
  button.append(footer);
  button.addEventListener("click", () => selectNode(node, history));
  item.append(button);

  const children = history.children.get(node.id);
  if (children.length) {
    const list = element("ul", "tree-children");
    for (const child of children) list.append(renderNode(child, history));
    item.append(list);
  }
  return item;
}

function emptyRow(label) {
  return element("p", "empty-row", `No ${label} recorded for this version.`);
}

function section(title, count, content) {
  const wrapper = element("section", "audit-section");
  const heading = element("button", "audit-heading");
  heading.type = "button";
  heading.setAttribute("aria-expanded", "true");
  heading.append(element("span", "audit-title", title));
  heading.append(element("span", "audit-count", String(count)));
  const body = element("div", "audit-body");
  body.append(...content);
  heading.addEventListener("click", () => {
    const expanded = heading.getAttribute("aria-expanded") === "true";
    heading.setAttribute("aria-expanded", String(!expanded));
    body.hidden = expanded;
  });
  wrapper.append(heading, body);
  return wrapper;
}

function renderAttempts(items) {
  if (!items.length) return [emptyRow("attempts")];
  return items.map((item) => {
    const row = element("article", "audit-card");
    const top = element("div", "audit-card-top");
    top.append(element("strong", "", item.title));
    top.append(element("span", `pill ${item.status}`, item.status));
    row.append(top, element("p", "", item.result));
    return row;
  });
}

function renderFiles(items) {
  if (!items.length) return [emptyRow("file changes")];
  return items.map((item) => {
    const row = element("article", "file-row");
    const top = element("div", "file-top");
    top.append(element("code", "", item.path));
    const diff = element("span", "diff-count");
    diff.append(element("b", "added", `+${item.additions}`), element("b", "deleted", `−${item.deletions}`));
    top.append(diff);
    row.append(top, element("p", "", item.summary));
    return row;
  });
}

function renderEmails(items) {
  if (!items.length) return [emptyRow("emails")];
  return items.map((item) => {
    const row = element("article", "audit-card compact");
    const top = element("div", "audit-card-top");
    top.append(element("strong", "", item.subject), element("span", "pill neutral", item.status));
    row.append(top, element("p", "mono", `To ${item.to}`));
    return row;
  });
}

function renderConversations(items) {
  if (!items.length) return [emptyRow("conversations")];
  return items.map((item) => {
    const row = element("article", "audit-card compact");
    row.append(element("strong", "", item.with));
    row.append(element("span", "channel", item.channel));
    row.append(element("p", "", item.summary));
    return row;
  });
}

function renderMetrics(items) {
  if (!items.length) return [emptyRow("metrics")];
  return items.map((item) => {
    const row = element("article", `metric-card ${item.tone}`);
    row.append(element("span", "metric-label", item.label));
    row.append(element("strong", "metric-value", item.value));
    row.append(element("span", "metric-delta", item.delta));
    return row;
  });
}

function renderSpend(spend) {
  const card = element("article", "spend-card");
  card.append(element("strong", "spend-total", money(spend)));
  card.append(element("span", "spend-label", "Total agent spend"));
  const list = element("ul", "spend-list");
  for (const line of spend.breakdown) list.append(element("li", "", line));
  card.append(list);
  return [card];
}

function renderLessons(items) {
  if (!items.length) return [emptyRow("lessons")];
  return items.map((lesson, index) => {
    const row = element("article", "lesson-row");
    row.append(element("span", "lesson-number", String(index + 1).padStart(2, "0")));
    row.append(element("p", "", lesson));
    return row;
  });
}

function selectNode(node, history) {
  document.querySelectorAll(".version-node").forEach((button) => {
    const selected = button.dataset.nodeId === node.id;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });

  inspector.replaceChildren();
  const header = element("header", "inspector-header");
  const meta = element("div", "inspector-meta");
  meta.append(element("span", `status-badge ${node.status}`, node.status));
  meta.append(element("span", "mono", node.id));
  header.append(meta);
  const title = element("h2", "", node.name);
  title.id = "inspector-title";
  header.append(title, element("p", "inspector-strategy", node.strategy), element("p", "inspector-summary", node.summary));
  const timing = element("div", "timing-row");
  timing.append(element("span", "", node.actor), element("span", "", `${node.durationMinutes} min`), element("span", "", new Date(node.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })));
  header.append(timing);
  inspector.append(header);
  inspector.append(section("What the agent tried", node.attempts.length, renderAttempts(node.attempts)));
  inspector.append(section("Files changed", node.fileChanges.length, renderFiles(node.fileChanges)));
  inspector.append(section("Emails sent", node.emails.length, renderEmails(node.emails)));
  inspector.append(section("Conversations", node.conversations.length, renderConversations(node.conversations)));
  inspector.append(section("Money spent", 1, renderSpend(node.moneySpent)));
  inspector.append(section("Metrics achieved", node.metrics.length, renderMetrics(node.metrics)));
  inspector.append(section("Lessons learned", node.lessons.length, renderLessons(node.lessons)));

  if (window.innerWidth < 920) inspector.scrollIntoView({ behavior: "smooth", block: "start" });
  history.selected = node.id;
}

async function main() {
  const response = await fetch("/demo/version-history.json");
  if (!response.ok) throw new Error(`history request failed: ${response.status}`);
  const history = indexVersionHistory(await response.json());
  document.querySelector("#history-title").textContent = history.document.title;
  document.querySelector("#branch-count").textContent = String(history.document.nodes.length - 1);
  document.querySelector("#winner-count").textContent = String(history.document.nodes.filter((node) => node.status === "winner").length);
  const total = history.document.nodes.reduce((sum, node) => sum + node.moneySpent.amount, 0);
  document.querySelector("#total-spend").textContent = money({ amount: total, currency: "USD" });

  const list = element("ul", "tree-root");
  list.append(renderNode(history.root, history));
  treeElement.replaceChildren(list);
  selectNode(history.root, history);
}

main().catch((error) => {
  treeElement.replaceChildren(element("p", "load-error", `Could not load version history: ${error.message}`));
});
