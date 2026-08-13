import type {
  MeetingMinutesAttendeeGroup,
  MeetingMinutesConfirmedItem,
  MeetingRecord,
} from "./meetingMinutesSchema";

export interface MeetingMinutesAudioFile {
  filename: string;
  label: string;
}

export interface MeetingMinutesHtmlRenderInput {
  record: MeetingRecord;
  versionNumber: number;
  generatedAt: string;
  audioFiles: MeetingMinutesAudioFile[];
}

export function escapeMeetingMinutesHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function paragraphs(value: string): string {
  return value
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `<p>${escapeMeetingMinutesHtml(line)}</p>`)
    .join("");
}

function renderAttendees(groups: MeetingMinutesAttendeeGroup[]): string {
  if (groups.length === 0) return '<p class="empty">未提供出席人員。</p>';
  return `<dl class="attendees">${groups
    .map(
      (group) =>
        `<div><dt>${escapeMeetingMinutesHtml(group.department ?? "出席人員")}</dt><dd>${group.names
          .map(escapeMeetingMinutesHtml)
          .join("、")}</dd></div>`
    )
    .join("")}</dl>`;
}

function renderConfirmedItems(items: MeetingMinutesConfirmedItem[], empty: string): string {
  if (items.length === 0) return `<p class="empty">${escapeMeetingMinutesHtml(empty)}</p>`;
  return `<ol class="numbered-list">${items
    .map(
      (item) =>
        `<li><p>${escapeMeetingMinutesHtml(item.content)}</p>${
          item.sourceBasis
            ? `<small>依據：${escapeMeetingMinutesHtml(item.sourceBasis)}</small>`
            : ""
        }</li>`
    )
    .join("")}</ol>`;
}

function renderAudio(files: MeetingMinutesAudioFile[]): string {
  if (files.length === 0) {
    return '<p class="empty">此會議紀錄未附錄音，其他內容仍可離線閱讀。</p>';
  }
  for (const file of files) {
    if (!/^audio-\d+\.m4a$/.test(file.filename)) {
      throw new Error("meeting minutes audio filename is invalid");
    }
  }
  return `<div class="audio-list">${files
    .map(
      (file, index) => `<article class="audio-item">
        <div><strong>${escapeMeetingMinutesHtml(file.label)}</strong><small>${escapeMeetingMinutesHtml(file.filename)}</small></div>
        <audio id="audio-${index + 1}" controls preload="metadata"><source src="./${file.filename}"></audio>
        <label class="file-fallback">錄音無法載入時，可在本機重新選取
          <input type="file" accept="audio/*" data-audio-target="audio-${index + 1}">
        </label>
        <p class="audio-status" role="status"></p>
      </article>`
    )
    .join("")}</div>`;
}

export function renderMeetingMinutesHtml(input: MeetingMinutesHtmlRenderInput): string {
  const { record } = input;
  const title = `${record.title}－會議紀錄`;
  const date = record.date ? escapeMeetingMinutesHtml(record.date) : "未提供";
  const generatedAt = escapeMeetingMinutesHtml(input.generatedAt);

  return `<!DOCTYPE html>
<html lang="zh-Hant-TW">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self' blob: data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; media-src 'self' blob: data:">
  <title>${escapeMeetingMinutesHtml(title)}</title>
  <style>
    :root{--bg:#f2f4f6;--paper:#fff;--soft:#f7f9fb;--ink:#192330;--muted:#687586;--line:#d5dde6;--accent:#167d78;--accent-soft:#e7f4f2;--warn:#8a5a11;--shadow:0 14px 34px rgba(22,36,52,.08)}
    @media(prefers-color-scheme:dark){:root{--bg:#101419;--paper:#191f26;--soft:#151a20;--ink:#eef3f7;--muted:#a9b4c0;--line:#303a45;--accent:#72c9c2;--accent-soft:#17312f;--warn:#f0c36b;--shadow:none}}
    *{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang TC","Noto Sans TC","Microsoft JhengHei",sans-serif;line-height:1.72}.page{width:min(1160px,calc(100% - 32px));margin:28px auto 64px}.document-header,.section,nav{background:var(--paper);border:1px solid var(--line);box-shadow:var(--shadow)}.document-header{padding:34px 36px;margin-bottom:20px;border-radius:12px;border-top:4px solid var(--accent)}h1,h2,h3{line-height:1.35;margin-top:0}h1{font-size:clamp(1.85rem,3.5vw,2.8rem);margin-bottom:8px;letter-spacing:-.02em}h2{font-size:1.35rem;padding-bottom:11px;border-bottom:1px solid var(--line);margin-bottom:20px}h3{font-size:1.05rem;margin:0 0 8px}.subtitle{font-size:1.03rem;color:var(--muted);max-width:72ch}.meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:0;margin-top:22px;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}.meta div{padding:12px 14px}.meta div+div{border-left:1px solid var(--line)}.meta strong{display:block;color:var(--muted);font-size:.78rem;letter-spacing:.08em;text-transform:uppercase}.summary{margin-top:22px;max-width:78ch}.layout{display:grid;grid-template-columns:245px minmax(0,1fr);gap:20px;align-items:start}nav{position:sticky;top:18px;padding:16px;border-radius:10px}nav strong{display:block;margin:3px 9px 10px;font-size:.82rem;letter-spacing:.12em;color:var(--muted)}nav a{display:block;padding:8px 10px;color:var(--ink);text-decoration:none;border-left:2px solid transparent}nav a:hover,nav a:focus-visible{color:var(--accent);background:var(--accent-soft);border-left-color:var(--accent);outline:none}.section{padding:28px 30px;margin-bottom:18px;border-radius:10px}.attendees{margin:0}.attendees div{display:grid;grid-template-columns:minmax(90px,160px) 1fr;gap:16px;padding:10px 0;border-bottom:1px solid var(--line)}.attendees div:last-child{border-bottom:0}.attendees dt{font-weight:700;color:var(--muted)}.attendees dd{margin:0}.audio-list,.topics{display:grid;gap:14px}.audio-item,.topic{border-top:1px solid var(--line);padding:16px 0}.audio-item:first-child,.topic:first-child{border-top:0}.audio-item>div{display:flex;justify-content:space-between;gap:16px}.audio-item small{color:var(--muted)}audio{width:100%;margin:12px 0}.file-fallback{display:block;color:var(--muted);font-size:.86rem}.file-fallback input{display:block;margin-top:6px;max-width:100%}.audio-status{font-size:.84rem;color:var(--warn)}.topic{display:grid;grid-template-columns:42px minmax(0,1fr);gap:14px}.topic-no{width:34px;height:34px;border:1px solid var(--accent);color:var(--accent);display:grid;place-items:center;border-radius:50%;font-weight:800}.topic-body p{margin:7px 0}.topic-label{display:inline-block;margin-right:8px;color:var(--muted);font-size:.78rem;letter-spacing:.08em;font-weight:700}.direction{margin-top:12px;padding-left:14px;border-left:3px solid var(--accent)}.numbered-list{padding-left:1.35rem}.numbered-list li{padding:6px 0 9px;border-bottom:1px solid var(--line)}.numbered-list li:last-child{border-bottom:0}.numbered-list p{margin:0}.numbered-list small{color:var(--muted)}.rows{display:grid}.row{display:grid;grid-template-columns:minmax(0,1fr) minmax(120px,210px);gap:20px;padding:12px 0;border-bottom:1px solid var(--line)}.row:last-child{border-bottom:0}.row p{margin:0}.row small{color:var(--muted)}.terms{display:flex;flex-wrap:wrap;gap:8px;padding:0;list-style:none}.terms li{border:1px solid var(--line);padding:4px 9px;border-radius:999px;color:var(--muted)}.empty{color:var(--muted);font-style:italic}.footer{color:var(--muted);font-size:.82rem;text-align:center;padding:20px}
    @media(max-width:880px){.layout{grid-template-columns:1fr}nav{position:static;display:flex;overflow:auto;gap:4px}nav strong{display:none}nav a{white-space:nowrap;border-left:0;border-bottom:2px solid transparent}.meta div+div{border-left:0}.document-header,.section{padding:24px 22px}.topic{grid-template-columns:34px minmax(0,1fr)}.row{grid-template-columns:1fr}.attendees div{grid-template-columns:1fr;gap:2px}}
    @media(max-width:480px){.page{width:min(100% - 20px,1160px);margin-top:10px}.document-header,.section{padding:20px 16px}.meta{grid-template-columns:1fr}.audio-item>div{display:block}h1{font-size:1.75rem}}
    @media print{body{background:#fff}.page{width:100%;margin:0}.document-header,.section,nav{box-shadow:none}nav,.file-fallback,.audio-status{display:none}.layout{display:block}.section{break-inside:avoid-page}}
  </style>
</head>
<body>
  <div class="page">
    <header class="document-header">
      <h1>${escapeMeetingMinutesHtml(title)}</h1>
      <p class="subtitle">${escapeMeetingMinutesHtml(record.subtitle)}</p>
      <div class="meta">
        <div><strong>會議日期</strong>${date}</div>
        <div><strong>文件版本</strong>v${input.versionNumber}</div>
        <div><strong>產生時間</strong>${generatedAt}</div>
      </div>
      <div class="summary">${paragraphs(record.executiveSummary)}</div>
    </header>
    <div class="layout">
      <nav aria-label="章節導覽"><strong>CONTENTS</strong>
        <a href="#attendees">出席人員</a><a href="#audio">錄音</a><a href="#topics">一、會議討論重點</a><a href="#facts">二、人工確認事實</a><a href="#decisions">三、已定案事項</a><a href="#requirements">四、系統需求整理</a><a href="#pending">五、仍需確認</a><a href="#actions">六、後續工作</a>
      </nav>
      <main>
        <section id="attendees" class="section"><h2>出席人員</h2>${renderAttendees(record.attendees)}</section>
        <section id="audio" class="section"><h2>錄音</h2>${renderAudio(input.audioFiles)}</section>
        <section id="topics" class="section"><h2>一、會議討論重點</h2><div class="topics">${
          record.discussionPoints.length > 0
            ? record.discussionPoints
                .map(
                  (point, index) => `<article class="topic"><div class="topic-no">${index + 1}</div><div class="topic-body"><h3>${escapeMeetingMinutesHtml(point.title)}</h3>${
                    point.currentProblem
                      ? `<p><span class="topic-label">現況問題</span>${escapeMeetingMinutesHtml(point.currentProblem)}</p>`
                      : ""
                  }<p><span class="topic-label">討論內容</span>${escapeMeetingMinutesHtml(point.discussion)}</p>${
                    point.direction
                      ? `<p class="direction"><span class="topic-label">目前方向</span>${escapeMeetingMinutesHtml(point.direction)}</p>`
                      : ""
                  }</div></article>`
                )
                .join("")
            : '<p class="empty">沒有可確認的討論重點。</p>'
        }</div></section>
        <section id="facts" class="section"><h2>二、人工確認事實</h2>${renderConfirmedItems(record.confirmedFacts, "未提供人工確認事實。")}</section>
        <section id="decisions" class="section"><h2>三、已定案事項</h2>${renderConfirmedItems(record.confirmedDecisions, "目前沒有可確認的定案事項。")}</section>
        <section id="requirements" class="section"><h2>四、系統需求整理</h2><div class="rows">${
          record.systemRequirements.length > 0
            ? record.systemRequirements
                .map(
                  (item) => `<div class="row"><p>${escapeMeetingMinutesHtml(item.content)}</p><small>${item.owner ? `責任單位：${escapeMeetingMinutesHtml(item.owner)}` : "責任單位：待確認"}</small></div>`
                )
                .join("")
            : '<p class="empty">沒有可確認的系統需求。</p>'
        }</div></section>
        <section id="pending" class="section"><h2>五、仍需確認</h2><div class="rows">${
          record.pendingItems.length > 0
            ? record.pendingItems
                .map(
                  (item) => `<div class="row"><p>${escapeMeetingMinutesHtml(item.content)}</p><small>${item.requiredConfirmation ? escapeMeetingMinutesHtml(item.requiredConfirmation) : "確認方式未提供"}</small></div>`
                )
                .join("")
            : '<p class="empty">沒有列出的待確認事項。</p>'
        }</div>${
          record.uncertainTerms.length > 0
            ? `<h3>逐字稿未能確認的詞彙</h3><ul class="terms">${record.uncertainTerms.map((term) => `<li>${escapeMeetingMinutesHtml(term)}</li>`).join("")}</ul>`
            : ""
        }</section>
        <section id="actions" class="section"><h2>六、後續工作</h2><div class="rows">${
          record.followUpActions.length > 0
            ? record.followUpActions
                .map(
                  (item) => `<div class="row"><p>${escapeMeetingMinutesHtml(item.content)}</p><small>${item.owner ? `負責：${escapeMeetingMinutesHtml(item.owner)}` : "負責：待確認"}${item.dueDate ? `<br>期限：${escapeMeetingMinutesHtml(item.dueDate)}` : ""}</small></div>`
                )
                .join("")
            : '<p class="empty">沒有列出的後續工作。</p>'
        }</div></section>
      </main>
    </div>
    <footer class="footer">此文件由固定版型產生；人工確認資料優先於逐字稿。</footer>
  </div>
  <script>
    document.querySelectorAll('audio').forEach(function(audio){
      var status=audio.parentElement.querySelector('.audio-status');
      audio.addEventListener('loadedmetadata',function(){if(status)status.textContent='錄音已載入：'+Math.round(audio.duration)+' 秒';});
      audio.addEventListener('error',function(){if(status)status.textContent='錄音未載入，請確認與 index.html 位於同一資料夾，或使用下方本機選檔。';});
    });
    document.querySelectorAll('[data-audio-target]').forEach(function(input){
      input.addEventListener('change',function(){
        var file=input.files&&input.files[0];var audio=document.getElementById(input.dataset.audioTarget);if(!file||!audio)return;
        if(audio.dataset.objectUrl)URL.revokeObjectURL(audio.dataset.objectUrl);
        var url=URL.createObjectURL(file);audio.dataset.objectUrl=url;audio.src=url;audio.load();
      });
    });
  </script>
</body>
</html>`;
}
