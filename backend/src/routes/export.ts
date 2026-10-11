import { Router } from 'express';
import PDFDocument from 'pdfkit';
import { getDb } from '../ctx';
import { wrap } from '../lib/errors';
import { parseRange, toCsv } from './util';

export const exporter = Router();

exporter.get(
  '/usage.csv',
  wrap(async (req, res) => {
    const { from } = parseRange(req.query.range);
    const { rows } = await getDb().query(
      `SELECT u.ts, u.provider, u.model, COALESCE(w.name,'') AS workflow, u.input_tokens, u.output_tokens, u.units, u.cost_usd, u.simulated
       FROM usage_events u LEFT JOIN workflows w ON w.id = u.workflow_id WHERE u.org_id=$1 AND u.ts >= $2 ORDER BY u.ts DESC LIMIT 100000`,
      [req.user!.orgId, from.toISOString()],
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="usage.csv"');
    res.send(toCsv(['timestamp', 'provider', 'model', 'workflow', 'input_tokens', 'output_tokens', 'units', 'cost_usd', 'simulated'], rows.map((r) => [r.ts, r.provider, r.model, r.workflow, r.input_tokens, r.output_tokens, r.units, Number(r.cost_usd).toFixed(6), r.simulated])));
  }),
);

exporter.get(
  '/runs.csv',
  wrap(async (req, res) => {
    const { from } = parseRange(req.query.range);
    const { rows } = await getDb().query(
      `SELECT queued_at, kind, ref_name, status, trigger, model, input_tokens, output_tokens, cost_usd, latency_ms, simulated, error
       FROM job_runs WHERE org_id=$1 AND queued_at >= $2 ORDER BY queued_at DESC LIMIT 100000`,
      [req.user!.orgId, from.toISOString()],
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="runs.csv"');
    res.send(toCsv(['queued_at', 'kind', 'name', 'status', 'trigger', 'model', 'input_tokens', 'output_tokens', 'cost_usd', 'latency_ms', 'simulated', 'error'], rows.map((r) => [r.queued_at, r.kind, r.ref_name, r.status, r.trigger, r.model ?? '', r.input_tokens, r.output_tokens, Number(r.cost_usd).toFixed(6), r.latency_ms ?? '', r.simulated, r.error ?? ''])));
  }),
);

exporter.get(
  '/report.pdf',
  wrap(async (req, res) => {
    const org = req.user!.orgId;
    const { from, days } = parseRange(req.query.range);
    const db = getDb();
    const [totals, byModel, byWf, runs, orgRow] = await Promise.all([
      db.query<{ cost: number; tokens: number; sim: number; n: number }>(
        `SELECT COALESCE(SUM(cost_usd),0)::float8 AS cost, COALESCE(SUM(input_tokens+output_tokens),0)::float8 AS tokens, COUNT(*) FILTER (WHERE simulated)::int AS sim, COUNT(*)::int AS n
         FROM usage_events WHERE org_id=$1 AND ts >= $2`, [org, from.toISOString()]),
      db.query<{ label: string; cost: number; tokens: number }>(
        `SELECT CASE WHEN model='' THEN provider ELSE model END AS label, SUM(cost_usd)::float8 AS cost, COALESCE(SUM(input_tokens+output_tokens),0)::float8 AS tokens
         FROM usage_events WHERE org_id=$1 AND ts >= $2 GROUP BY 1 ORDER BY cost DESC LIMIT 12`, [org, from.toISOString()]),
      db.query<{ label: string; cost: number }>(
        `SELECT COALESCE(w.name,'Ad-hoc prompts') AS label, SUM(u.cost_usd)::float8 AS cost FROM usage_events u LEFT JOIN workflows w ON w.id=u.workflow_id
         WHERE u.org_id=$1 AND u.ts >= $2 GROUP BY 1 ORDER BY cost DESC LIMIT 10`, [org, from.toISOString()]),
      db.query<{ total: number; failed: number }>(
        `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status='failed')::int AS failed FROM job_runs WHERE org_id=$1 AND queued_at >= $2`, [org, from.toISOString()]),
      db.query<{ name: string }>('SELECT name FROM organizations WHERE id=$1', [org]),
    ]);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="higgsfield-report.pdf"');
    const doc = new PDFDocument({ margin: 48, info: { Title: 'Higgsfield Studio usage report' } });
    doc.pipe(res);

    doc.fontSize(20).text('Higgsfield Studio — Usage report');
    doc.moveDown(0.3).fontSize(10).fillColor('#555').text(`${orgRow.rows[0].name} · last ${days} days · generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`);
    doc.fillColor('#000').moveDown();
    doc.fontSize(12).text(`Total estimated spend: $${totals.rows[0].cost.toFixed(2)}`);
    doc.text(`Tokens: ${Math.round(totals.rows[0].tokens).toLocaleString('en-US')}`);
    doc.text(`Runs: ${runs.rows[0].total} (${runs.rows[0].failed} failed)`);
    if (totals.rows[0].sim > 0) {
      doc.moveDown(0.5).fillColor('#b45309').fontSize(10).text(`Note: ${totals.rows[0].sim} of ${totals.rows[0].n} usage events are simulated/demo data and are not real spend.`).fillColor('#000');
    }
    doc.moveDown().fontSize(14).text('Spend by model');
    doc.fontSize(10);
    for (const r of byModel.rows) doc.text(`${r.label.padEnd(24)}  $${r.cost.toFixed(2).padStart(9)}   ${Math.round(r.tokens).toLocaleString('en-US')} tokens`);
    doc.moveDown().fontSize(14).text('Spend by workflow');
    doc.fontSize(10);
    for (const r of byWf.rows) doc.text(`${r.label.slice(0, 40).padEnd(40)}  $${r.cost.toFixed(2).padStart(9)}`);
    doc.moveDown().fontSize(8).fillColor('#666').text('Costs are estimates computed from reported token usage and configured model prices; they may differ from your invoice.');
    doc.end();
  }),
);
