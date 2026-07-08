/**
 * 撈 Ragic 各表單的 server-side workflow JS（doc.jsp / API key 撈不到的那層）。
 *
 * 認證：txtedit.jsp 只認「登入 session cookie」、不認 API key（已 probe 驗證）。
 * 所以這支必須在「你本機、Ragic 登入 session 還活著時」跑，cookie 由環境變數帶進來——
 * 不寫進 script、不進 git、不經過任何人。
 *
 * 讀取端（F12 逆向確認）：
 *   GET /sims/txtedit.jsp?leaveBtn&paramLoc=cust/def/app/<form_path>_Sheet<id>_index.nui&sec=5
 *   + Cookie: JSESSIONID=...
 *   → 回 HTML，<textarea id="txt"> 內就是現有 workflow JS。
 *   （sec=5 經 form 71 / 26 驗證為固定值，疑似帳號權限等級，可用 env 覆蓋）
 *
 * 憑證三選一（都不上 git；密碼比 cookie 更敏感，同樣只放本機檔或 shell export）：
 *   ① 建 .cache/ragic-cookie.txt 貼整串 cookie（手動，最穩，已 gitignore）
 *   ② export RAGIC_COOKIE='JSESSIONID=...; ...'
 *   ③ export RAGIC_USER=... RAGIC_PASS=...（自動 /AUTH 換新 session；能否打進 txtedit.jsp 需 probe 驗）
 *   （手動 cookie 來源：瀏覽器 F12 → Network 任一 request 的 Cookie）
 *   node --import tsx scripts/dump-ragic-workflows.ts --probe   # 先驗一張（form 71）三種 scope
 *   node --import tsx scripts/dump-ragic-workflows.ts           # probe OK 後撈全部
 *
 * 撈完的 .js 落在 .cache/ragic-workflows/（gitignore）；分析（接進 ragic_field_edge）是下一支。
 */
import { open } from "sqlite";
import sqlite3 from "sqlite3";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DOMAIN = process.env.RAGIC_DOMAIN || "fdtw.app";
// 憑證來源（優先序）：手動 cookie（RAGIC_COOKIE / .cache/ragic-cookie.txt）> 帳密自動 /AUTH。
// 都不上 git；密碼比 cookie 更敏感，同樣只放本機檔（.cache 已 gitignore）或 shell export。
const COOKIE_FILE = process.env.RAGIC_COOKIE_FILE || ".cache/ragic-cookie.txt";
// 帳密（給 /AUTH 自動換 session 用）：優先 env，否則讀 .cache/ragic-auth.txt（第一行帳號、第二行密碼）
const AUTH_FILE = process.env.RAGIC_AUTH_FILE || ".cache/ragic-auth.txt";
let COOKIE = "";

function loadCredentials(): { user: string; pass: string } {
  if (process.env.RAGIC_USER && process.env.RAGIC_PASS) {
    return { user: process.env.RAGIC_USER, pass: process.env.RAGIC_PASS };
  }
  if (existsSync(AUTH_FILE)) {
    const lines = readFileSync(AUTH_FILE, "utf-8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length >= 2) return { user: lines[0]!, pass: lines[1]! };
  }
  return { user: "", pass: "" };
}
const DB =
  process.env.RAGIC_DUMP_DB || ".cache/work-report-read-model.v1.sqlite3";
// sec = workflow scope（逆向發現）：1=pre-workflow、2=post-workflow、5=button/sheet scope。
// 預設撈這三種；可用 env 撈更多（萬一 3/4 也有）。每張表逐 sec 撈、有 JS 才存。
const SECS = (process.env.RAGIC_TXTEDIT_SECS || "1,2,5")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const SEC_LABEL: Record<string, string> = { "1": "pre", "2": "post", "5": "button" };
const OUT = "./.cache/ragic-workflows";
const PROBE_FORM = process.env.RAGIC_PROBE_FORM || "default/forms8/71";

/** textarea 內的 JS 是 HTML-escaped，還原回純 JS（&amp; 最後解，避免 &amp;lt; 連鎖）*/
function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#x2F;/gi, "/")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/** 分層剝殼：textarea#txt → 任一 textarea → 無 HTML 視為純 JS → null */
function extractJs(html: string): string | null {
  const byId = /<textarea[^>]*\bid=["']txt["'][^>]*>([\s\S]*?)<\/textarea>/i.exec(html);
  if (byId) return decodeEntities(byId[1] ?? "");
  const anyTa = /<textarea[^>]*>([\s\S]*?)<\/textarea>/i.exec(html);
  if (anyTa) return decodeEntities(anyTa[1] ?? "");
  if (!/<html|<body|<form|<!doctype/i.test(html)) return html; // 看起來就是純 JS
  return null;
}

function paramLocFor(formPath: string): string {
  const id = formPath.split("/").pop() ?? "";
  return `cust/def/app/${formPath}_Sheet${id}_index.nui`;
}

async function fetchWorkflowHtml(
  formPath: string,
  sec: string
): Promise<{ html: string; status: number }> {
  const paramLoc = paramLocFor(formPath);
  const url = `https://${DOMAIN}/sims/txtedit.jsp?leaveBtn&paramLoc=${encodeURIComponent(paramLoc)}&sec=${sec}`;
  const res = await fetch(url, { headers: { Cookie: COOKIE } });
  return { html: await res.text(), status: res.status };
}

function manualCookie(): string {
  if (process.env.RAGIC_COOKIE) return process.env.RAGIC_COOKIE.trim();
  if (existsSync(COOKIE_FILE)) return readFileSync(COOKIE_FILE, "utf-8").trim();
  return "";
}

/**
 * 用帳密跟 /AUTH 換一個全新 session。
 * ⚠️ 未驗證：/AUTH 的 sid 是「對外 API」session，txtedit.jsp 是「內部編輯器」認瀏覽器
 * JSESSIONID——兩者是否同一套 session 未知。能不能打進 txtedit.jsp，靠 probe 才知道。
 */
async function authViaCredentials(user: string, pass: string): Promise<string> {
  const url =
    `https://${DOMAIN}/AUTH?u=${encodeURIComponent(user)}` +
    `&p=${encodeURIComponent(pass)}&login_type=sessionId&json=1&api=`;
  const res = await fetch(url);
  const body = (await res.text()).trim();
  if (body === "-1") throw new Error("/AUTH 認證失敗（帳密錯或被擋）");
  let sid = body;
  try {
    const j = JSON.parse(body) as { sid?: unknown };
    if (typeof j.sid === "string") sid = j.sid;
  } catch {
    // 非 JSON → 當裸 sid 容錯
  }
  if (!sid) throw new Error("/AUTH 回應沒有 sid");
  console.log(`[auth] /AUTH 換得新 session（sid 前 8 碼 ${sid.slice(0, 8)}…）`);
  return `JSESSIONID=${sid}`;
}

/** 憑證解析：手動 cookie 優先（最穩），否則帳密自動 /AUTH（待 probe 驗證能否打 txtedit.jsp）*/
async function resolveCookie(): Promise<string> {
  const manual = manualCookie();
  if (manual) {
    console.log("[auth] 用手動 cookie（RAGIC_COOKIE / .cache/ragic-cookie.txt）");
    return manual;
  }
  const { user, pass } = loadCredentials();
  if (user && pass) {
    return authViaCredentials(user, pass);
  }
  throw new Error(
    `沒有可用憑證，擇一（都在 .cache 已 gitignore）：\n` +
      `  (A) 建 ${COOKIE_FILE} 貼整串 cookie（手動，最穩）\n` +
      `  (B) 建 ${AUTH_FILE}：第一行帳號、第二行密碼（自動 /AUTH，需 probe 驗能否打 txtedit.jsp）\n` +
      `  (C) shell：export RAGIC_COOKIE=... 或 RAGIC_USER=... RAGIC_PASS=...\n` +
      `cookie 來源：瀏覽器 F12 → Network → 任一 request → Headers → Cookie`
  );
}

async function loadFormPaths(probe: boolean): Promise<string[]> {
  if (probe) return [PROBE_FORM];
  const db = await open({ filename: DB, driver: sqlite3.Database });
  const rows = await db.all<Array<{ form_path: string }>>(
    "SELECT DISTINCT form_path FROM ragic_field_index ORDER BY form_path"
  );
  await db.close();
  return rows.map((r) => r.form_path);
}

async function main(): Promise<void> {
  COOKIE = await resolveCookie();
  const probe = process.argv.includes("--probe");
  mkdirSync(OUT, { recursive: true });
  mkdirSync(join(OUT, "_raw"), { recursive: true });

  const forms = await loadFormPaths(probe);
  console.log(`${probe ? "[probe] " : ""}準備撈 ${forms.length} 張表單 workflow → ${OUT}`);

  let ok = 0;
  let empty = 0;
  let fail = 0;
  for (const fp of forms) {
    const safe = fp.replace(/[/\\]/g, "_");
    for (const sec of SECS) {
      const label = SEC_LABEL[sec] ?? `sec${sec}`;
      const stem = `${safe}__${label}`;
      try {
        const { html, status } = await fetchWorkflowHtml(fp, sec);
        const js = extractJs(html);
        if (js && js.trim()) {
          writeFileSync(join(OUT, "_raw", `${stem}.raw.html`), html, "utf-8");
          writeFileSync(join(OUT, `${stem}.js`), js, "utf-8");
          ok += 1;
          console.log(`[ok]    ${fp} [${label}] → ${js.trim().length} 字`);
        } else {
          // 多數表單某些 scope 沒設 workflow（空）很正常，批次不存 _raw 省空間；probe 才存供診斷
          empty += 1;
          if (probe) {
            writeFileSync(join(OUT, "_raw", `${stem}.raw.html`), html, "utf-8");
            console.log(`[empty] ${fp} [${label}]（status ${status}, ${html.length} bytes）— 看 _raw/${stem}.raw.html`);
          }
        }
      } catch (error) {
        fail += 1;
        console.log(`[fail]  ${fp} [${label}]: ${error instanceof Error ? error.message : String(error)}`);
      }
      await new Promise((r) => setTimeout(r, 350)); // 別打太密
    }
  }

  console.log(`\n完成：有 JS ${ok} / 空 ${empty} / 失敗 ${fail}（${forms.length} 表 × ${SECS.length} scope）`);
  if (probe) {
    console.log(
      ok > 0
        ? `\nprobe 成功 → 看 ${OUT}/ 下 ${PROBE_FORM.replace(/[/\\]/g, "_")}__*.js（pre / post / button 哪些有內容），確認是你的 workflow，沒問題就拿掉 --probe 撈全部。`
        : `\nprobe 三種 scope 都空 → 看 ${OUT}/_raw/ 的 HTML：是登入頁=cookie 過期重抓；是空編輯器=paramLoc 要校。`
    );
  }
}

void main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
