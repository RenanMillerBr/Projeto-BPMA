import { NextResponse, type NextRequest } from "next/server";

import {
  StatusFechamentoTemperaturaEquipamento,
  StatusOperacionalEquipamento,
  TipoOpcaoTemperaturaEquipamento,
  TurnoTemperaturaEquipamento
} from "@prisma/client";

import { APP_NAME } from "@/lib/app-branding";
import { getCurrentUser } from "@/lib/auth-session";
import {
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

const MODULE_CODE = OPERATIONAL_SIGNATURE_MODULES.temperatura.codigo;
const MODULE_NAME = "Controle de Temperatura dos Equipamentos";
const REPORT_TITLE = "CONTROLE DE TEMPERATURA DOS EQUIPAMENTOS";
const REPORT_NAME = "Relatório mensal - temperatura dos equipamentos";
const SHIFTS = [
  TurnoTemperaturaEquipamento.MANHA,
  TurnoTemperaturaEquipamento.TARDE
] as const;

type TemperatureRecord = Awaited<ReturnType<typeof getMonthlyTemperatureRecords>>[number];
type EquipmentOption = Awaited<ReturnType<typeof getTemperatureEquipmentOptions>>[number];

type ShiftCell = {
  temperature: string;
  correctiveAction: string;
  responsible: string;
  supervisor: string;
};

type EquipmentReport = {
  name: string;
  cellsByDayShift: Map<string, ShiftCell>;
};

type MonthlyTemperatureReport = {
  month: number;
  year: number;
  monthYearLabel: string;
  unitName: string;
  emittedAt: string;
  equipments: EquipmentReport[];
  days: number[];
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

function valueOrEmpty(value: string | null | undefined): string {
  return value?.trim() ?? "";
}

function valueOrDash(value: string | null | undefined): string {
  const normalized = value?.trim() ?? "";
  return normalized || "-";
}

function formatTemperature(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return "";
  }

  return `${value.toLocaleString("pt-BR", {
    minimumFractionDigits: Number.isInteger(value) ? 0 : 1,
    maximumFractionDigits: 1
  })} °C`;
}

function labelTurno(turno: TurnoTemperaturaEquipamento): string {
  return turno === TurnoTemperaturaEquipamento.MANHA ? "Manhã" : "Tarde";
}

function getRecordDateKey(record: Pick<TemperatureRecord, "data">): string {
  return formatAppDateInput(record.data);
}

function getRecordKey(params: {
  equipment: string;
  turno: TurnoTemperaturaEquipamento;
  day: number;
}): string {
  return `${params.equipment}|${params.turno}|${params.day}`;
}

function getCellKey(turno: TurnoTemperaturaEquipamento, day: number): string {
  return `${turno}|${day}`;
}

function escapeHtml(value: string | number | null | undefined): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function getTemperatureEquipmentOptions() {
  return prisma.controleTemperaturaEquipamentoOpcao.findMany({
    where: { tipo: TipoOpcaoTemperaturaEquipamento.EQUIPAMENTO },
    select: {
      nome: true,
      ativo: true
    },
    orderBy: [{ ativo: "desc" }, { nome: "asc" }]
  });
}

async function getMonthlyTemperatureRecords(month: number, year: number) {
  const monthRange = getAppMonthDateRange(month, year);

  return prisma.controleTemperaturaEquipamento.findMany({
    where: {
      data: {
        gte: monthRange.start,
        lte: monthRange.end
      }
    },
    select: {
      id: true,
      data: true,
      equipamento: true,
      turno: true,
      statusOperacionalEquipamento: true,
      temperaturaAferida: true,
      acaoCorretiva: true,
      responsavel: true,
      createdAt: true
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }]
  });
}

function buildEquipmentNames(
  equipmentOptions: EquipmentOption[],
  records: TemperatureRecord[]
): string[] {
  const recordsByEquipment = new Map<string, TemperatureRecord[]>();
  for (const record of records) {
    const group = recordsByEquipment.get(record.equipamento) ?? [];
    group.push(record);
    recordsByEquipment.set(record.equipamento, group);
  }

  const optionsByName = new Map(equipmentOptions.map((option) => [option.nome, option]));
  const equipmentNames: string[] = [];

  for (const option of equipmentOptions) {
    if (option.ativo || recordsByEquipment.has(option.nome)) {
      equipmentNames.push(option.nome);
    }
  }

  const extraEquipmentNames = Array.from(recordsByEquipment.keys())
    .filter((name) => !optionsByName.has(name))
    .sort((first, second) => first.localeCompare(second, "pt-BR"));

  equipmentNames.push(...extraEquipmentNames);

  return equipmentNames;
}

function buildEquipmentReports(params: {
  equipmentOptions: EquipmentOption[];
  records: TemperatureRecord[];
  days: number[];
  supervisorByDate: Map<string, string>;
}): EquipmentReport[] {
  const recordsByKey = new Map<string, TemperatureRecord>();

  for (const record of params.records) {
    const key = getRecordKey({
      equipment: record.equipamento,
      turno: record.turno,
      day: record.data.getUTCDate()
    });

    if (!recordsByKey.has(key)) {
      recordsByKey.set(key, record);
    }
  }

  return buildEquipmentNames(params.equipmentOptions, params.records).map((name) => {
    const cellsByDayShift = new Map<string, ShiftCell>();

    for (const day of params.days) {
      for (const turno of SHIFTS) {
        const record = recordsByKey.get(getRecordKey({ equipment: name, turno, day }));
        if (!record) {
          continue;
        }

        const inOperation =
          record.statusOperacionalEquipamento === StatusOperacionalEquipamento.EM_OPERACAO;
        cellsByDayShift.set(getCellKey(turno, day), {
          temperature: inOperation ? formatTemperature(record.temperaturaAferida) : "",
          correctiveAction: inOperation
            ? valueOrEmpty(record.acaoCorretiva)
            : record.statusOperacionalEquipamento === StatusOperacionalEquipamento.MANUTENCAO
              ? "Em manutenção"
              : "",
          responsible: valueOrEmpty(record.responsavel),
          supervisor: valueOrDash(params.supervisorByDate.get(getRecordDateKey(record)))
        });
      }
    }

    return {
      name,
      cellsByDayShift
    };
  });
}

function renderStyles(): string {
  return `
    <style>
      @page {
        size: A4 landscape;
        margin: 7mm;
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
        font-size: 8.2px;
        line-height: 1.18;
      }

      body {
        padding: 0;
      }

      .screen-actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        margin: 10px auto;
        max-width: 1120px;
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

      .equipment-page {
        display: flex;
        min-height: 196mm;
        page-break-after: always;
        break-after: page;
        flex-direction: column;
        gap: 5px;
        padding: 0;
      }

      .equipment-page:last-child {
        page-break-after: auto;
        break-after: auto;
      }

      table {
        width: 100%;
        border-collapse: collapse;
        color: #000000;
      }

      th,
      td {
        border: 1px solid #000000;
        padding: 2px 3px;
        text-align: center;
        vertical-align: middle;
      }

      th {
        background: #f2f2f2;
        font-weight: 700;
      }

      .header-table {
        table-layout: fixed;
      }

      .brand-cell {
        width: 20%;
        font-size: 12px;
        text-align: center;
      }

      .brand-cell span {
        display: block;
        margin-top: 2px;
        font-size: 8px;
        font-weight: 400;
      }

      .title-cell {
        width: 54%;
        font-size: 14px;
        font-weight: 700;
        letter-spacing: 0;
        text-align: center;
      }

      .month-cell {
        width: 26%;
        font-size: 10px;
        text-align: center;
      }

      .meta-line {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        justify-content: space-between;
        font-size: 8px;
      }

      .equipment-info {
        table-layout: fixed;
      }

      .equipment-info th {
        width: 16%;
        text-align: left;
      }

      .equipment-info td {
        text-align: left;
      }

      .temperature-table {
        table-layout: fixed;
      }

      .temperature-table th,
      .temperature-table td {
        overflow-wrap: anywhere;
      }

      .day-column {
        width: 4%;
        font-weight: 700;
      }

      .temperature-column {
        width: 8%;
      }

      .action-column {
        width: 16%;
      }

      .responsible-column,
      .supervisor-column {
        width: 10%;
      }

      .day-row td {
        height: 14px;
      }

      .footer-block {
        margin-top: auto;
      }

      .corrective-title {
        background: #f2f2f2;
        font-weight: 700;
        text-align: center;
        text-transform: uppercase;
      }

      .corrective-table {
        table-layout: fixed;
      }

      .corrective-table th,
      .corrective-table td {
        padding: 2px 3px;
        text-align: left;
        vertical-align: top;
      }

      .corrective-table th {
        text-align: center;
      }

      .corrective-range {
        width: 22%;
        font-weight: 700;
        text-align: center;
        white-space: nowrap;
      }

      .signature-table {
        table-layout: fixed;
        margin-top: 4px;
      }

      .signature-table th,
      .signature-table td {
        height: 20px;
        text-align: left;
        white-space: nowrap;
      }

      .signature-table th:first-child {
        width: 30%;
      }

      .signature-table td:nth-child(2) {
        width: 42%;
      }

      .signature-table th:nth-child(3) {
        width: 7%;
      }

      .signature-table td:nth-child(4) {
        width: 21%;
      }

      .empty-message {
        height: 42px;
        text-align: center;
      }

      @media print {
        .screen-actions {
          display: none;
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

function renderHeader(report: MonthlyTemperatureReport): string {
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

function renderEquipmentInfo(equipment: EquipmentReport, report: MonthlyTemperatureReport): string {
  return `
    <table class="equipment-info">
      <tbody>
        <tr>
          <th>Mês/Ano</th>
          <td>${escapeHtml(report.monthYearLabel)}</td>
          <th>Equipamento</th>
          <td>${escapeHtml(equipment.name)}</td>
        </tr>
      </tbody>
    </table>`;
}

function renderShiftHeader(): string {
  return `
    <th class="temperature-column">Temperatura</th>
    <th class="action-column">Ação corretiva</th>
    <th class="responsible-column">Responsável</th>
    <th class="supervisor-column">Supervisor</th>`;
}

function renderShiftCells(equipment: EquipmentReport, day: number, turno: TurnoTemperaturaEquipamento): string {
  const cell = equipment.cellsByDayShift.get(getCellKey(turno, day));

  return `
    <td>${escapeHtml(cell?.temperature ?? "")}</td>
    <td>${escapeHtml(cell?.correctiveAction ?? "")}</td>
    <td>${escapeHtml(cell?.responsible ?? "")}</td>
    <td>${escapeHtml(cell?.supervisor ?? "")}</td>`;
}

function renderEquipmentTable(equipment: EquipmentReport, report: MonthlyTemperatureReport): string {
  const rows = report.days
    .map(
      (day) => `
        <tr class="day-row">
          <td class="day-column">${day}</td>
          ${renderShiftCells(equipment, day, TurnoTemperaturaEquipamento.MANHA)}
          ${renderShiftCells(equipment, day, TurnoTemperaturaEquipamento.TARDE)}
        </tr>`
    )
    .join("");

  return `
    <table class="temperature-table">
      <thead>
        <tr>
          <th class="day-column" rowspan="2">Dia</th>
          <th colspan="4">${escapeHtml(labelTurno(TurnoTemperaturaEquipamento.MANHA))}</th>
          <th colspan="4">${escapeHtml(labelTurno(TurnoTemperaturaEquipamento.TARDE))}</th>
        </tr>
        <tr>
          ${renderShiftHeader()}
          ${renderShiftHeader()}
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderCorrectiveActionBlock(): string {
  return `
    <table class="corrective-table">
      <tbody>
        <tr>
          <th colspan="4" class="corrective-title">Ação corretiva para equipamentos de refrigeração e congelamento</th>
        </tr>
        <tr>
          <td class="corrective-range">Acima de 8°C</td>
          <td>TEMPERATURAS INADEQUADAS - SOLICITAR MANUTENÇÃO URGENTE</td>
          <td class="corrective-range">Abaixo de -13°C</td>
          <td>TEMPERATURAS INADEQUADAS - SOLICITAR MANUTENÇÃO URGENTE</td>
        </tr>
        <tr>
          <td class="corrective-range">Entre 5°C e 8°C</td>
          <td>VARIAÇÃO ACEITÁVEL PARA O TURNO, SE PERSISTIR NO TURNO SEGUINTE ACIONAR A MANUTENÇÃO</td>
          <td class="corrective-range">Entre -17°C e -14°C</td>
          <td>VARIAÇÃO ACEITÁVEL PARA O TURNO, SE PERSISTIR NO TURNO SEGUINTE ACIONAR A MANUTENÇÃO</td>
        </tr>
        <tr>
          <td class="corrective-range">Até 4°C</td>
          <td>FAIXA IDEAL DE TEMPERATURA</td>
          <td class="corrective-range">Até -18°C</td>
          <td>FAIXA IDEAL DE TEMPERATURA</td>
        </tr>
        <tr>
          <th colspan="4" class="corrective-title">Ação corretiva para equipamentos a quente (banho maria, estufa, passthrough e placa de indução)</th>
        </tr>
        <tr>
          <td class="corrective-range">Abaixo de 80°C</td>
          <td>AGUARDAR ATINGIR A TEMPERATURA ADEQUADA</td>
          <td class="corrective-range">ACIMA DE 80°C</td>
          <td>FAIXA IDEAL DE TEMPERATURA</td>
        </tr>
      </tbody>
    </table>`;
}

function renderClosureSignature(report: MonthlyTemperatureReport): string {
  return `
    <table class="signature-table">
      <tbody>
        <tr>
          <th>Responsável Técnico ou Nutricionista:</th>
          <td>${escapeHtml(report.closureResponsible)}</td>
          <th>Data:</th>
          <td>${escapeHtml(report.closureDate)}</td>
        </tr>
      </tbody>
    </table>`;
}

function renderEquipmentPage(equipment: EquipmentReport, report: MonthlyTemperatureReport): string {
  return `
    <section class="equipment-page">
      ${renderHeader(report)}
      ${renderEquipmentInfo(equipment, report)}
      ${renderEquipmentTable(equipment, report)}
      <div class="footer-block">
        ${renderCorrectiveActionBlock()}
        ${renderClosureSignature(report)}
      </div>
    </section>`;
}

function renderReportDocument(report: MonthlyTemperatureReport): string {
  const equipmentPages =
    report.equipments.length > 0
      ? report.equipments.map((equipment) => renderEquipmentPage(equipment, report)).join("")
      : `
        <section class="equipment-page">
          ${renderHeader(report)}
          <table>
            <tbody>
              <tr>
                <td class="empty-message">Nenhum equipamento encontrado para o mês de referência.</td>
              </tr>
            </tbody>
          </table>
          <div class="footer-block">
            ${renderCorrectiveActionBlock()}
            ${renderClosureSignature(report)}
          </div>
        </section>`;

  return `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(REPORT_TITLE)} - ${escapeHtml(report.monthYearLabel)}</title>
    ${renderStyles()}
  </head>
  <body>
    <div class="screen-actions">
      <button type="button" onclick="window.print()">Imprimir / Salvar PDF</button>
    </div>
    <main>
      ${equipmentPages}
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
  const days = Array.from({ length: monthRange.end.getUTCDate() }, (_, index) => index + 1);
  const generatedAt = getAppNow();

  const [
    equipmentOptions,
    records,
    dailySignatures,
    genericMonthlyClosure,
    legacyMonthlyClosure
  ] = await Promise.all([
    getTemperatureEquipmentOptions(),
    getMonthlyTemperatureRecords(month, year),
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
    prisma.controleTemperaturaEquipamentoFechamento.findUnique({
      where: { mes_ano: { mes: month, ano: year } }
    })
  ]);

  const supervisorByDate = new Map(
    dailySignatures.map((signature) => [
      formatAppDateInput(signature.dataReferencia),
      signature.usuarioNomeSnapshot
    ])
  );

  const closureResponsible =
    genericMonthlyClosure?.usuarioNomeSnapshot ??
    (legacyMonthlyClosure?.status === StatusFechamentoTemperaturaEquipamento.ASSINADO
      ? legacyMonthlyClosure.responsavelTecnico
      : "");
  const closureDate =
    genericMonthlyClosure
      ? formatGeneratedAtSentence(genericMonthlyClosure.assinadoEm)
      : legacyMonthlyClosure?.status === StatusFechamentoTemperaturaEquipamento.ASSINADO
        ? formatGeneratedAtSentence(legacyMonthlyClosure.dataAssinatura)
        : "";

  const report: MonthlyTemperatureReport = {
    month,
    year,
    monthYearLabel: formatMonthYear(month, year),
    unitName: getConfiguredUnitName(),
    emittedAt: formatAppDateTime(generatedAt),
    equipments: buildEquipmentReports({
      equipmentOptions,
      records,
      days,
      supervisorByDate
    }),
    days,
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
