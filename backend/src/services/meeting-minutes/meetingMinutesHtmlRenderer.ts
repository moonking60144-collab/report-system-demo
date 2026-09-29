import { meetingMinutesDocumentStyles, meetingMinutesSignature } from "./meetingMinutesDocumentStyles";
import { meetingMinutesParagraphs } from "./meetingMinutesParagraphs";
import type {
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
  includeAudio?: boolean;
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
  return meetingMinutesParagraphs(value)
    .map((line) => `<p>${escapeMeetingMinutesHtml(line)}</p>`)
    .join("");
}

function topicField(label: string, value: string): string {
  return `<div class="topic-field"><h4 class="topic-label">${label}</h4>${paragraphs(value)}</div>`;
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
    if (!/^audio-\d+\.(?:m4a|webm)$/.test(file.filename)) {
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
  <meta name="color-scheme" content="light">
  <meta http-equiv="Content-Security-Policy" content="${input.includeAudio === false ? "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'" : "default-src 'self' blob: data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; media-src 'self' blob: data:"}">
  <title>${escapeMeetingMinutesHtml(title)}</title>
  <style>${meetingMinutesDocumentStyles}</style>
</head>
<body>
  <div class="page">
    <header class="document-header">
      <h1>${escapeMeetingMinutesHtml(title)}</h1>
      <p class="subtitle">${escapeMeetingMinutesHtml(record.subtitle)}</p>
      <p class="subtitle">AI 整理草稿，待人工確認。請對照原文核對流程、數字與決議。</p>
      <div class="meta">
        <div><strong>會議日期</strong>${date}</div>
        <div><strong>文件版本</strong>v${input.versionNumber}</div>
        <div><strong>產生時間</strong>${generatedAt}</div>
      </div>
      <div class="summary">${paragraphs(record.executiveSummary)}</div>
    </header>
    <div class="layout">
      <nav aria-label="章節導覽"><strong>CONTENTS</strong>
        <a href="#signatures">簽名</a>${input.includeAudio === false ? "" : '<a href="#audio">錄音</a>'}<a href="#topics">一、會議討論重點</a><a href="#facts">二、人工確認事實</a><a href="#decisions">三、已定案事項</a><a href="#requirements">四、系統需求整理</a><a href="#pending">五、仍需確認</a><a href="#actions">六、後續工作</a>
        ${(record.additionalSections ?? []).map((section, index) => `<a href="#additional-${index + 1}">${escapeMeetingMinutesHtml(section.title)}</a>`).join("")}
      </nav>
      <main>
        ${meetingMinutesSignature}
        ${input.includeAudio === false ? "" : `<section id="audio" class="section"><h2>錄音</h2>${renderAudio(input.audioFiles)}</section>`}
        <section id="topics" class="section"><h2>一、會議討論重點</h2><div class="topics">${
          record.discussionPoints.length > 0
            ? record.discussionPoints
                .map(
                  (point, index) => `<article class="topic"><div class="topic-no">${index + 1}</div><div class="topic-body"><h3>${escapeMeetingMinutesHtml(point.title)}</h3>${
                    point.currentProblem
                      ? topicField("現況問題", point.currentProblem)
                      : ""
                  }${topicField("討論內容", point.discussion)}${
                    point.direction
                      ? topicField("目前方向", point.direction)
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
                  (item) => `<div class="row"><p>${escapeMeetingMinutesHtml(item.content)}</p></div>`
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
                  (item) => `<div class="row"><p>${escapeMeetingMinutesHtml(item.content)}</p>${item.dueDate ? `<small>期限：${escapeMeetingMinutesHtml(item.dueDate)}</small>` : ""}</div>`
                )
                .join("")
            : '<p class="empty">沒有列出的後續工作。</p>'
        }</div></section>
        ${(record.additionalSections ?? []).map((section, index) => `<section id="additional-${index + 1}" class="section"><h2>${escapeMeetingMinutesHtml(section.title)}</h2>${paragraphs(section.content)}</section>`).join("")}
      </main>
    </div>
    <footer class="footer">會議紀錄 · 請以人工確認內容為準。</footer>
  </div>
  ${input.includeAudio === false ? "" : `<script>
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
  </script>`}
</body>
</html>`;
}
