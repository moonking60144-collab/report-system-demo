export interface MaskedTimeInputResult {
  value: string;
  invalidAttempt: boolean;
}

export function to24HourTime(value: string | null | undefined): string {
  if (!value) {
    return "";
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  const plainMatch = trimmed.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (plainMatch) {
    const hour = plainMatch[1]?.padStart(2, "0") ?? "";
    const minute = plainMatch[2] ?? "";
    return `${hour}:${minute}`;
  }

  const meridiemMatch = trimmed.match(/^(上午|下午|am|pm)\s*(\d{1,2}):(\d{2})(?::(\d{2}))?$/i);
  if (!meridiemMatch) {
    return "";
  }

  const marker = meridiemMatch[1]?.toLowerCase() ?? "";
  const minute = meridiemMatch[3] ?? "";
  let hour = Number(meridiemMatch[2] ?? "0");

  const isPm = marker === "下午" || marker === "pm";
  const isAm = marker === "上午" || marker === "am";

  if (isPm && hour < 12) {
    hour += 12;
  } else if (isAm && hour === 12) {
    hour = 0;
  }

  return `${String(hour).padStart(2, "0")}:${minute}`;
}

export function maskTimeInput(rawValue: string): string {
  return maskTimeInputResult(rawValue).value;
}

export function maskTimeInputResult(rawValue: string): MaskedTimeInputResult {
  // 已經有 `:` 就尊重使用者輸入（方便中間編輯、backspace 等操作），
  // 只做範圍檢查；不強制走 digit-only 重組把 `:` strip 掉重組
  // （原本 strip 後 "1:00" 會變 "10:0" 這種反直覺行為）
  const colonMatch = rawValue.match(/^(\d{0,2}):(\d{0,2})$/);
  if (colonMatch) {
    const hourPart = colonMatch[1] ?? "";
    const minutePart = colonMatch[2] ?? "";
    const hourOk = hourPart === "" || Number(hourPart) <= 23;
    const minuteOk = minutePart === "" || Number(minutePart) <= 59;
    return {
      value: rawValue,
      invalidAttempt: !(hourOk && minuteOk),
    };
  }

  const digits = rawValue.replace(/\D/g, "").slice(0, 4);
  if (digits.length <= 2) {
    return {
      value: digits,
      invalidAttempt: false,
    };
  }

  const isValidHour = (value: string): boolean => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 && parsed <= 23;
  };

  const isValidMinute = (value: string): boolean => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 && parsed <= 59;
  };

  const isValidMinuteLeadingDigit = (value: string): boolean => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 && parsed <= 5;
  };

  if (digits.length === 3) {
    const hourCandidate = digits.slice(0, 2);
    const minuteLeadingDigit = digits.slice(2);
    if (isValidHour(hourCandidate)) {
      return {
        value: isValidMinuteLeadingDigit(minuteLeadingDigit)
          ? `${hourCandidate}:${minuteLeadingDigit}`
          : `${hourCandidate}:`,
        invalidAttempt: !isValidMinuteLeadingDigit(minuteLeadingDigit),
      };
    }

    const fallbackHour = `0${digits[0]}`;
    const fallbackMinute = digits.slice(1);
    if (isValidHour(fallbackHour)) {
      return {
        value: isValidMinute(fallbackMinute) ? `${fallbackHour}:${fallbackMinute}` : `${fallbackHour}:`,
        invalidAttempt: !isValidMinute(fallbackMinute),
      };
    }

    return {
      value: hourCandidate,
      invalidAttempt: true,
    };
  }

  const hourCandidate = digits.slice(0, 2);
  const minuteCandidate = digits.slice(2);
  if (isValidHour(hourCandidate)) {
    if (isValidMinute(minuteCandidate)) {
      return {
        value: `${hourCandidate}:${minuteCandidate}`,
        invalidAttempt: false,
      };
    }
    return {
      value: isValidMinuteLeadingDigit(minuteCandidate.slice(0, 1))
        ? `${hourCandidate}:${minuteCandidate.slice(0, 1)}`
        : `${hourCandidate}:`,
      invalidAttempt: true,
    };
  }

  const fallbackHour = `0${digits[0]}`;
  const fallbackMinute = digits.slice(1, 3);
  if (isValidHour(fallbackHour)) {
    if (isValidMinute(fallbackMinute)) {
      return {
        value: `${fallbackHour}:${fallbackMinute}`,
        invalidAttempt: false,
      };
    }
    return {
      value: isValidMinuteLeadingDigit(fallbackMinute.slice(0, 1))
        ? `${fallbackHour}:${fallbackMinute.slice(0, 1)}`
        : `${fallbackHour}:`,
      invalidAttempt: true,
    };
  }

  return {
    value: hourCandidate,
    invalidAttempt: true,
  };
}

export function formatTimeDisplay(value: string | null | undefined): string {
  const normalized = to24HourTime(value);
  if (normalized) {
    return normalized;
  }
  return String(value ?? "").trim();
}
