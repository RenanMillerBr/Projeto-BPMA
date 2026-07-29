import { NextResponse, type NextRequest } from "next/server";

import { StatusFechamentoQualidadeOleo } from "@prisma/client";

import { APP_NAME } from "@/lib/app-branding";
import { getCurrentUser } from "@/lib/auth-session";
import {
  formatAppDate,
  formatAppDateInput,
  formatAppDateTime,
  getAppDate,
  getAppMonthDateRange,
  getAppMonthYear,
  getAppNow
} from "@/lib/date-time";
import { OPERATIONAL_SIGNATURE_MODULES } from "@/lib/module-signatures";
import { prisma } from "@/lib/prisma";
import { canAccessReports } from "@/lib/rbac";

export const dynamic = "force-dynamic";

const MODULE_CODE = OPERATIONAL_SIGNATURE_MODULES.oleo.codigo;
const MODULE_NAME = "Controle da Qualidade do Óleo";
const REPORT_TITLE = "CONTROLE DA QUALIDADE DO ÓLEO";
const REPORT_NAME = "Relatório mensal - controle da qualidade do óleo";

type OilReportRow = {
  data: string;
  fitaOleo: string;
  temperatura: string;
  responsavel: string;
  supervisor: string;
  observacao: string;
};

type MonthlyOilReport = {
  monthYearLabel: string;
  unitName: string;
  emittedAt: string;
  rows: OilReportRow[];
  closureResponsible: string;
  closureDate: string;
  closureStatus: string;
};

function parseMonth(value: string | null): number | null {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= 12 ? parsed : null;
}

function parseYear(value: string | null): number | null {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 2020 && parsed <= 2100 ? parsed : null;
}

function getConfiguredUnitName(): string {
  return (
    process.env.STAYSAFE_UNIT_NAME?.trim() ||
    process.env.BPMA_UNIT_NAME?.trim() ||
    "Unidade não informada"
  );
}

function getMonthName(month: number): string {
  const monthNames = [
    "JANEIRO",
    "FEVEREIRO",
    "MARÇO",
    "ABRIL",
    "MAIO",
    "JUNHO",
    "JULHO",
    "AGOSTO",
    "SETEMBRO",
    "OUTUBRO",
    "NOVEMBRO",
    "DEZEMBRO"
  ];

  return monthNames[month - 1] ?? "";
}

function formatMonthYear(month: number, year: number): string {
  return `${getMonthName(month)} ${year}`;
}

function formatGeneratedAtSentence(date: Date): string {
  const [datePart, timePart] = formatAppDateTime(date).split(" ");
  return `${datePart} às ${timePart ?? ""}`.trim();
}

function valueOrDash(value: string | null | undefined): string {
  const normalized = value?.trim() ?? "";
  return normalized || "-";
}

function formatOilStrip(value: string | null | undefined): string {
  const normalized = value?.trim() ?? "";
  if (!normalized) {
    return "-";
  }

  return normalized.includes("%") ? normalized : `${normalized}%`;
}

function formatTemperature(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return "-";
  }

  return `${value.toLocaleString("pt-BR", {
    minimumFractionDigits: Number.isInteger(value) ? 0 : 1,
    maximumFractionDigits: 1
  })} °C`;
}

function escapeHtml(value: string | number | null | undefined): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderStyles(): string {
  return `
    <style>
      @page {
        size: A4 portrait;
        margin: 10mm;
      }

      * {
        box-sizing: border-box;
      }

      html,
      body {
        margin: 0;
        background: #ffffff;
        color: #000000;
        font-family: Arial, Helvetica, sans-serif;
        font-size: 11px;
        line-height: 1.35;
      }

      body {
        padding: 16px;
      }

      .report-page {
        max-width: 980px;
        margin: 0 auto;
        background: #ffffff;
      }

      .screen-actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        margin-bottom: 10px;
      }

      .screen-actions button {
        border: 1px solid #111827;
        border-radius: 6px;
        background: #111827;
        color: #ffffff;
        cursor: pointer;
        font-size: 12px;
        padding: 7px 10px;
      }

      table {
        width: 100%;
        border-collapse: collapse;
        color: #000000;
      }

      th,
      td {
        border: 1px solid #000000;
        padding: 5px 6px;
        vertical-align: top;
      }

      th {
        background: #f2f2f2;
        font-weight: 700;
        text-align: center;
      }

      .header-table {
        table-layout: fixed;
        margin-bottom: 8px;
      }

      .brand-cell {
        width: 20%;
        font-size: 13px;
        text-align: center;
        vertical-align: middle;
      }

      .brand-cell span {
        display: block;
        margin-top: 3px;
        font-size: 9px;
        font-weight: 400;
      }

      .title-cell {
        width: 54%;
        font-size: 15px;
        font-weight: 700;
        letter-spacing: 0;
        text-align: center;
        vertical-align: middle;
      }

      .month-cell {
        width: 26%;
        font-size: 11px;
        text-align: center;
        vertical-align: middle;
      }

      .meta-line {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        justify-content: space-between;
        margin-bottom: 8px;
        font-size: 10px;
      }

      .records-table {
        table-layout: fixed;
      }

      .records-table th:nth-child(1),
      .records-table td:nth-child(1) {
        width: 12%;
        text-align: center;
      }

      .records-table th:nth-child(2),
      .records-table td:nth-child(2),
      .records-table th:nth-child(3),
      .records-table td:nth-child(3) {
        width: 16%;
        text-align: center;
      }

      .records-table th:nth-child(4),
      .records-table td:nth-child(4),
      .records-table th:nth-child(5),
      .records-table td:nth-child(5) {
        width: 18%;
      }

      .records-table th:nth-child(6),
      .records-table td:nth-child(6) {
        width: 20%;
      }

      .empty-message {
        height: 28px;
        text-align: center;
      }

      .signature-table {
        table-layout: fixed;
        margin-top: 14px;
      }

      .signature-table th,
      .signature-table td {
        height: 30px;
        text-align: left;
        white-space: nowrap;
        vertical-align: middle;
      }

      .signature-table th:first-child {
        width: 34%;
      }

      .signature-table td:nth-child(2) {
        width: 38%;
      }

      .signature-table th:nth-child(3) {
        width: 7%;
      }

      .signature-table td:nth-child(4) {
        width: 21%;
      }

      @media print {
        body {
          padding: 0;
        }

        .screen-actions {
          display: none;
        }

        .report-page {
          max-width: none;
        }

        thead {
          display: table-header-group;
        }

        tr {
          break-inside: avoid;
        }
      }
    </style>`;
}

function renderHeader(report: MonthlyOilReport): string {
  return `
    <header>
      <table class="header-table">
        <tbody>
          <tr>
            <td class="brand-cell">
              <strong>${escapeHtml(APP_NAME)}</strong>
              <span>${escapeHtml(report.unitName)}</span>
            </td>
            <td class="title-cell">${escapeHtml(REPORT_TITLE)}</td>
            <td class="month-cell">
              <strong>Mês/Ano</strong><br />
              ${escapeHtml(report.monthYearLabel)}
            </td>
          </tr>
        </tbody>
      </table>
      <div class="meta-line">
        <span><strong>Relatório:</strong> ${escapeHtml(REPORT_NAME)}</span>
        <span><strong>Módulo:</strong> ${escapeHtml(MODULE_NAME)}</span>
        <span><strong>Emissão:</strong> ${escapeHtml(report.emittedAt)}</span>
        <span><strong>Fechamento mensal:</strong> ${escapeHtml(report.closureStatus)}</span>
      </div>
    </header>`;
}

function renderRecordsTable(report: MonthlyOilReport): string {
  const rows =
    report.rows.length > 0
      ? report.rows
          .map(
            (row) => `
              <tr>
                <td>${escapeHtml(row.data)}</td>
                <td>${escapeHtml(row.fitaOleo)}</td>
                <td>${escapeHtml(row.temperatura)}</td>
                <td>${escapeHtml(row.responsavel)}</td>
                <td>${escapeHtml(row.supervisor)}</td>
                <td>${escapeHtml(row.observacao)}</td>
              </tr>`
          )
          .join("")
      : `
        <tr>
          <td colspan="6" class="empty-message">
            Nenhum registro encontrado para o período.
          </td>
        </tr>`;

  return `
    <table class="records-table">
      <thead>
        <tr>
          <th>Data</th>
          <th>% da Fita do Óleo</th>
          <th>Temperatura (T°C)</th>
          <th>Responsável</th>
          <th>Supervisor</th>
          <th>Observação / ação</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderFooter(report: MonthlyOilReport): string {
  const responsible =
    report.closureResponsible.trim() || "________________________________________";
  const date = report.closureDate.trim() || "___/___/____";

  return `
    <footer>
      <table class="signature-table">
        <tbody>
          <tr>
            <th>Responsável Técnico ou Nutricionista:</th>
            <td>${escapeHtml(responsible)}</td>
            <th>Data:</th>
            <td>${escapeHtml(date)}</td>
          </tr>
        </tbody>
      </table>
    </footer>`;
}

function renderReportDocument(report: MonthlyOilReport): string {
  return `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(REPORT_TITLE)} - ${escapeHtml(report.monthYearLabel)}</title>
    ${renderStyles()}
  </head>
  <body>
    <main class="report-page">
      <div class="screen-actions">
        <button type="button" onclick="window.print()">Imprimir / Salvar PDF</button>
      </div>
      ${renderHeader(report)}
      ${renderRecordsTable(report)}
      ${renderFooter(report)}
    </main>
  </body>
</html>`;
}

export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  if (!canAccessReports(user)) {
    return NextResponse.redirect(new URL("/acesso-negado", request.url));
  }

  const currentMonthYear = getAppMonthYear(getAppDate());
  const month = parseMonth(request.nextUrl.searchParams.get("mes")) ?? currentMonthYear.mes;
  const year = parseYear(request.nextUrl.searchParams.get("ano")) ?? currentMonthYear.ano;
  const monthRange = getAppMonthDateRange(month, year);
  const generatedAt = getAppNow();

  const [records, dailySignatures, genericMonthlyClosure, legacyMonthlyClosure] = await Promise.all([
    prisma.controleQualidadeOleoRegistro.findMany({
      where: {
        data: {
          gte: monthRange.start,
          lte: monthRange.end
        }
      },
      select: {
        data: true,
        fitaOleo: true,
        temperatura: true,
        responsavel: true,
        orientacao: true,
        observacao: true
      },
      orderBy: [{ data: "asc" }, { createdAt: "asc" }, { id: "asc" }]
    }),
    prisma.assinaturaDiariaModulo.findMany({
      where: {
        moduloCodigo: MODULE_CODE,
        dataReferencia: {
          gte: monthRange.start,
          lte: monthRange.end
        }
      },
      select: {
        dataReferencia: true,
        usuarioNomeSnapshot: true
      }
    }),
    prisma.fechamentoMensalModulo.findUnique({
      where: {
        moduloCodigo_ano_mes: {
          moduloCodigo: MODULE_CODE,
          ano: year,
          mes: month
        }
      }
    }),
    prisma.controleQualidadeOleoFechamento.findUnique({
      where: { mes_ano: { mes: month, ano: year } }
    })
  ]);

  const closureResponsible =
    genericMonthlyClosure?.usuarioNomeSnapshot ??
    (legacyMonthlyClosure?.status === StatusFechamentoQualidadeOleo.ASSINADO
      ? legacyMonthlyClosure.responsavelTecnico
      : "");
  const closureDate =
    genericMonthlyClosure
      ? formatGeneratedAtSentence(genericMonthlyClosure.assinadoEm)
      : legacyMonthlyClosure?.status === StatusFechamentoQualidadeOleo.ASSINADO
        ? formatGeneratedAtSentence(legacyMonthlyClosure.dataAssinatura)
        : "";

  const dailySignaturesByDate = new Map(
    dailySignatures.map((signature) => [
      formatAppDateInput(signature.dataReferencia),
      signature
    ])
  );

  const report: MonthlyOilReport = {
    monthYearLabel: formatMonthYear(month, year),
    unitName: getConfiguredUnitName(),
    emittedAt: formatAppDateTime(generatedAt),
    rows: records.map((record) => {
      const dailySignature = dailySignaturesByDate.get(formatAppDateInput(record.data));

      return {
        data: formatAppDate(record.data),
        fitaOleo: formatOilStrip(record.fitaOleo),
        temperatura: formatTemperature(record.temperatura),
        responsavel: valueOrDash(record.responsavel),
        supervisor: valueOrDash(dailySignature?.usuarioNomeSnapshot),
        observacao: valueOrDash(record.observacao?.trim() || record.orientacao)
      };
    }),
    closureResponsible,
    closureDate,
    closureStatus: closureResponsible ? "Assinado digitalmente" : "Pendente de assinatura"
  };

  return new NextResponse(renderReportDocument(report), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}
