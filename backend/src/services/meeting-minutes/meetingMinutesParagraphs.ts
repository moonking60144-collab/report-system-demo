export function meetingMinutesParagraphs(value: string): string[] {
  return value.split(/\r?\n+/).flatMap(line => {
    const sentences = line.trim().match(/[^。！？!?]*[。！？!?]+[」』”’]?|[^。！？!?]+$/g) ?? [];
    const result: string[] = [];
    let paragraph = "";
    for (const sentence of sentences) {
      if (paragraph.length >= 120) {
        result.push(paragraph.trim());
        paragraph = "";
      }
      paragraph += sentence;
    }
    if (paragraph.trim()) result.push(paragraph.trim());
    return result;
  });
}
