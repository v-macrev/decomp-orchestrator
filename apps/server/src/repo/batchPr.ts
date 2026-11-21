// SPDX-License-Identifier: AGPL-3.0-or-later
// The text of a batch pull request: one title, one commit message and one description naming every
// function of every unit, in the repository's own PR template (as `sr submit` fills it per task).

/** The parts of `last-compare.json` (sr compare's summary) that a PR reports. */
export interface CompareSummary {
  unit: string;
  source_revision?: string;
  recipe?: string;
  recipe_sha256?: string;
  compiler?: string;
  image_sha256_pinned?: boolean;
  comparator?: unknown;
  contract_version?: number;
  functions: Array<{
    rva: string; name?: string | null; result: string; reason?: string | null;
    candidate_size?: number | null; target_size?: number | null; coverage?: unknown; code_section_sha256?: string | null;
  }>;
}

const TITLE_MAX = 200;
const SEPARATOR = '|---|---|---|---|---|---|';

/** One functions-table row, exactly as sr's pr_body writes it. */
const row = (r: CompareSummary['functions'][number]) =>
  `| \`${r.rva}\` | \`${r.name ?? ''}\` | ${r.result} | \`${r.reason ?? ''}\` | ${r.candidate_size ?? ''}/${r.target_size ?? ''} | \`${(r.code_section_sha256 ?? '').slice(0, 16)}\` |`;

/** The sanitized report of one unit, with the keys sr's pr_body keeps (hashes, counts, reason codes). */
const report = (s: CompareSummary) => {
  const out: Record<string, unknown> = {};
  for (const k of ['unit', 'source_revision', 'recipe', 'recipe_sha256', 'compiler', 'image_sha256_pinned', 'comparator', 'contract_version'] as const) out[k] = s[k];
  out.functions = s.functions.map((r) => ({
    rva: r.rva, result: r.result, reason: r.reason, candidate_size: r.candidate_size, target_size: r.target_size, coverage: r.coverage, code_section_sha256: r.code_section_sha256,
  }));
  return out;
};

export function batchPrText(summaries: CompareSummary[], draftedBy: string) {
  const fns = summaries.flatMap((s) => s.functions);
  const units = summaries.length;
  const label = (f: CompareSummary['functions'][number]) => f.name || f.rva;
  const full = `Reconstruct ${fns.map(label).join(', ')} (${fns.map((f) => f.rva).join(', ')})`;
  let title = full;
  if (full.length > TITLE_MAX) {
    const head = `Reconstruct ${fns.length} functions in ${units} unit${units === 1 ? '' : 's'}: `;
    const shown: string[] = [];
    for (const f of fns) {
      const rest = fns.length - shown.length - 1;
      const next = `${head}${[...shown, label(f)].join(', ')}${rest ? ` and ${rest} more` : ''}`;
      if (next.length > TITLE_MAX) break;
      shown.push(label(f));
    }
    const rest = fns.length - shown.length;
    title = `${head}${shown.join(', ')}${rest ? ` and ${rest} more` : ''}`;
  }
  const perUnit = summaries.map((s) => `- ${s.unit}: ${s.functions.map((f) => `${f.rva} ${f.name ?? ''}`.trim()).join(', ')}`);
  const message = [
    title,
    '',
    ...(title === full ? [] : [`${fns.length} functions in ${units} unit(s):`, '']),
    ...perUnit,
    '',
    `Drafted by ${draftedBy}. Local comparator pass with the pinned recipe; not yet confirmed by the project.`,
  ].join('\n');
  const reportJson = JSON.stringify(units === 1 ? report(summaries[0]!) : summaries.map(report), null, 1);
  const unitsSection = ['## Units in this pull request', '', `${fns.length} functions in ${units} unit(s), one commit; each unit passed the local comparator with the pinned recipe in this same tree.`, '', ...perUnit, '', ''].join('\n');

  /** Fill `template`: sr's own description of one task (or the bare PR template) becomes the batch's. */
  const body = (template: string, toolRevision: string) => {
    const rows = fns.map(row).join('\n');
    let text = template
      .replace('{{functions_table}}', rows)
      .replace('{{report_json}}', reportJson)
      .replace('{{drafted_by}}', draftedBy)
      .replace('{{tool_revision}}', toolRevision)
      .replace('{{label_findings}}', '- see the checks on this pull request')
      .replace('{{origin_findings}}', '- see the checks on this pull request');
    // sr's filled description: swap its one task's rows and report for every unit's.
    const sep = text.indexOf(SEPARATOR);
    if (sep >= 0) {
      const start = sep + SEPARATOR.length + 1;
      const end = text.indexOf('\n\n', start);
      if (end > start) text = `${text.slice(0, start)}${rows}${text.slice(end)}`;
    }
    text = text.replace(/```json\n[\s\S]*?\n```/, () => `\`\`\`json\n${reportJson}\n\`\`\``);
    text = text.replace(/at tool revision `[0-9a-f]+`/, `at tool revision \`${toolRevision}\``);
    if (units > 1 && !text.includes('## Units in this pull request')) {
      const at = text.indexOf('## Sanitized local comparator summary');
      text = at >= 0 ? `${text.slice(0, at)}${unitsSection}${text.slice(at)}` : `${text.trimEnd()}\n\n${unitsSection}`;
    }
    return text.endsWith('\n') ? text : `${text}\n`;
  };
  return { title, message, body };
}
