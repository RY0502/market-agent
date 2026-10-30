/** Normalize supported financial amounts and units into the application's units. */
export function normalizeMetricText(field: string, input: string): number | undefined {
  let text = input.trim();
  if (text.includes(',')) {
    const grouped = /^((?:INR|Rs\.?|\u20b9)\s*)?([+-]?(?:\d{1,3}(?:,\d{3})+|\d{1,2}(?:,\d{2})+,\d{3})(?:\.\d+)?)(.*)$/i.exec(text);
    if (!grouped) return undefined;
    text = `${grouped[1] ?? ''}${grouped[2]!.replaceAll(',', '')}${grouped[3]}`;
  }
  const match = /^(?:(INR|Rs\.?|\u20b9)\s*)?([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s*(crores?|cr\.?|lakhs?|lacs?|trillions?|tn|t|billions?|bn|b|millions?|mn|m|rupees?|INR|Rs\.?|%|x)?$/i.exec(text);
  if (!match) return undefined;
  const number = Number(match[2]);
  if (!Number.isFinite(number) || (Number.isInteger(number) && !Number.isSafeInteger(number)) ||
      (number === 0 && /[1-9]/.test(match[2]!))) return undefined;
  const unit = (match[3] ?? '').toLowerCase().replace(/\.$/, '');
  const currency = Boolean(match[1]);
  let multiplier = 1;
  if (field === 'marketCapCrore') {
    if (/^(crores?|cr)$/.test(unit)) multiplier = 1;
    else if (/^(lakhs?|lacs?)$/.test(unit)) multiplier = 0.01;
    else if (/^(trillions?|tn|t)$/.test(unit)) multiplier = 100_000;
    else if (/^(billions?|bn|b)$/.test(unit)) multiplier = 100;
    else if (/^(millions?|mn|m)$/.test(unit)) multiplier = 0.1;
    else if (/^(rupees?|inr|rs)$/.test(unit) || (currency && !unit)) multiplier = 1 / 10_000_000;
    else if (unit) return undefined;
  } else if (field === 'livePrice') {
    if (unit && !/^(rupees?|inr|rs)$/.test(unit)) return undefined;
  } else if (currency || (unit && unit !== (field === 'earningsGrowthPercent' ? '%' : 'x'))) {
    return undefined;
  }
  const value = number * multiplier;
  return Number.isFinite(value) && !(number !== 0 && value === 0) ? value : undefined;
}

/** Check whether a financial value can be derived from an observed text token. */
export function metricOccursInText(field: string, value: number, text: string): boolean {
  const tokens = text.match(/(?:(?:INR|Rs\.?|\u20b9)\s*)?[+-]?(?:\d[\d,]*(?:\.\d+)?|\.\d+)(?:\s*(?:crores?|cr\b|lakhs?|lacs?|trillions?|tn\b|t\b|billions?|bn\b|b\b|millions?|mn\b|m\b|rupees?|INR\b|Rs\.?|%|x\b))?/gi) ?? [];
  return tokens.some(token => {
    const parsed = normalizeMetricText(field, token);
    return parsed !== undefined && Math.abs(parsed - value) <=
      Number.EPSILON * Math.max(1, Math.abs(parsed), Math.abs(value)) * 8;
  });
}
