import "server-only";

import {
  ClassificacaoItemBuffetAmostra,
  ConformidadeRecebimento,
  OrigemChamadoManutencao,
  StatusChamadoManutencao,
  StatusItemBuffetAmostra,
  StatusNotaRecebimento,
  StatusOperacionalEquipamento,
  StatusPlanoLimpeza,
  StatusQualidadeOleo,
  StatusRecebimento,
  StatusTemperaturaBuffetAmostra,
  StatusTemperaturaEquipamento,
  TipoTemperaturaRecebimento,
  TurnoPlanoLimpeza,
  TurnoTemperaturaEquipamento
} from "@prisma/client";

import type { AuthenticatedUser } from "@/lib/auth-session";
import {
  formatAppDate,
  formatAppDateInput,
  formatAppDateTime,
  getAppDate,
  getAppMonthYear,
  getAppMonthDateRange,
  getAppNow,
  getAppWeekDateRange,
  getEndOfAppDay,
  getStartOfAppDay,
  parseAppDateInput
} from "@/lib/date-time";
import { hasStoredImage as hasImageEvidence } from "@/lib/image-upload";
import { prisma } from "@/lib/prisma";
import { getRoleLabel } from "@/lib/rbac";

import {
  getFiltersForReport,
  getReportDefinition,
  getReportModule,
  type ReportModuleId
} from "./report-definitions";
import {
  formatSifDisplayValue,
  isSifNaValue
} from "../rastreabilidade-recebimento/sif";
import {
  getServicoPeriodoLabel,
  getTipoServicoLabel
} from "../controle-buffet-amostras/utils";
import { formatWeeklyExecutionQuando } from "../plano-limpeza/utils";

export type ReportSearchParams = Record<string, string | string[] | undefined>;
export type ReportColumn = { key: string; label: string };
export type ReportRow = Record<string, string | number | null>;
export type ReportSummaryItem = { label: string; value: string | number };
export type AppliedReportFilter = { label: string; value: string };
export type GeneratedReport = {
  moduleId: ReportModuleId;
  moduleLabel: string;
  reportId: string;
  reportLabel: string;
  periodLabel: string;
  generatedBy: string;
  generatedByRole: string;
  generatedAt: Date;
  appliedFilters: AppliedReportFilter[];
  summary: ReportSummaryItem[];
  columns: ReportColumn[];
  rows: ReportRow[];
  notes?: string[];
};

type DateRange = { start: Date; end: Date; startInput: string; endInput: string };

function getParam(params: ReportSearchParams, key: string): string {
  const value = params[key];
  return Array.isArray(value) ? value[0]?.trim() ?? "" : value?.trim() ?? "";
}

function parseDateInput(value: string): Date | null {
  return parseAppDateInput(value);
}

function formatDateInput(date: Date): string {
  return formatAppDateInput(date);
}

function formatDateDisplay(date: Date | null | undefined): string {
  if (!date) return "-";
  return formatAppDate(date);
}

function formatDateTimeDisplay(date: Date | null | undefined): string {
  if (!date) return "-";
  return formatAppDateTime(date);
}

function getDateRange(params: ReportSearchParams): DateRange {
  const today = getAppDate();
  const end = parseDateInput(getParam(params, "dataFinal")) ?? today;
  const fallbackStart = new Date(end);
  fallbackStart.setUTCDate(fallbackStart.getUTCDate() - 30);
  const start = parseDateInput(getParam(params, "dataInicial")) ?? fallbackStart;
  return { start, end, startInput: formatDateInput(start), endInput: formatDateInput(end) };
}

function getDateTimeRange(params: ReportSearchParams): { start: Date; end: Date } {
  const range = getDateRange(params);
  return { start: getStartOfAppDay(range.start), end: getEndOfAppDay(range.end) };
}

function getPeriodLabel(range: DateRange): string {
  return `${formatDateDisplay(range.start)} a ${formatDateDisplay(range.end)}`;
}

function normalize(value: unknown): string {
  return String(value ?? "").trim().toLocaleLowerCase("pt-BR");
}

function includesText(value: unknown, search: string): boolean {
  return !search || normalize(value).includes(normalize(search));
}

function hasText(value: unknown): boolean {
  return String(value ?? "").trim().length > 0;
}

function matchesYesNo(condition: boolean, filterValue: string): boolean {
  if (filterValue === "SIM") return condition;
  if (filterValue === "NAO") return !condition;
  return true;
}

function parseNumber(value: string): number | null {
  if (!value) return null;
  const parsed = Number(value.replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

function sameNumber(value: number | null | undefined, expected: number | null): boolean {
  if (expected === null) return true;
  if (value === null || value === undefined) return false;
  return Math.abs(value - expected) < 0.001;
}

function valueOrDash(value: unknown): string {
  const normalizedValue = String(value ?? "").trim();
  return normalizedValue || "-";
}

function formatTemperature(value: number | null | undefined): string {
  return value === null || value === undefined ? "-" : `${String(value).replace(".", ",")} °C`;
}

function formatRecebimentoValidade(
  date: Date | null | undefined,
  validadeNaoAplicavel: boolean
): string {
  return validadeNaoAplicavel ? "Sem validade" : formatDateDisplay(date);
}

function formatRecebimentoTemperatura(
  value: number | null | undefined,
  tipo: TipoTemperaturaRecebimento
): string {
  if (tipo === TipoTemperaturaRecebimento.AMBIENTE) return "Ambiente";
  if (tipo === TipoTemperaturaRecebimento.NAO_APLICAVEL) return "Não se aplica";
  return formatTemperature(value);
}

function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) return "-";
  return value.toLocaleString("pt-BR", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 4
  });
}

function formatCurrency(value: number | null | undefined): string {
  if (value === null || value === undefined) return "-";
  return value.toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4
  });
}

function labelConformidade(value: ConformidadeRecebimento | null | undefined): string {
  if (value === ConformidadeRecebimento.NAO_CONFORME) return "Não conforme";
  if (value === ConformidadeRecebimento.CONFORME) return "Conforme";
  return "-";
}

function labelTurnoTemperatura(value: TurnoTemperaturaEquipamento): string {
  return value === TurnoTemperaturaEquipamento.MANHA ? "Manhã" : "Tarde";
}

function labelTurnoLimpeza(value: TurnoPlanoLimpeza): string {
  if (value === TurnoPlanoLimpeza.MANHA) return "Manhã";
  if (value === TurnoPlanoLimpeza.TARDE) return "Tarde";
  return "Noite";
}

function labelStatusPlano(value: StatusPlanoLimpeza): string {
  if (value === StatusPlanoLimpeza.AGUARDANDO_SUPERVISOR) return "Aguardando supervisor";
  if (value === StatusPlanoLimpeza.CONCLUIDO) return "Concluído";
  return "Pendente";
}

function labelStatusTemperatura(value: StatusTemperaturaEquipamento): string {
  if (value === StatusTemperaturaEquipamento.ALERTA) return "Alerta";
  if (value === StatusTemperaturaEquipamento.CRITICO) return "Crítico";
  return "Normal";
}

function labelStatusOperacionalTemperatura(
  value: StatusOperacionalEquipamento
): string {
  if (value === StatusOperacionalEquipamento.MANUTENCAO) return "Manutenção";
  if (value === StatusOperacionalEquipamento.INATIVO) return "Inativo";
  return "Em Operação";
}

function isTemperaturaOperacional(value: StatusOperacionalEquipamento): boolean {
  return value === StatusOperacionalEquipamento.EM_OPERACAO;
}

function labelStatusOleo(value: StatusQualidadeOleo): string {
  if (value === StatusQualidadeOleo.ATENCAO) return "Atenção";
  if (value === StatusQualidadeOleo.ULTIMA_UTILIZACAO) return "Última utilização";
  if (value === StatusQualidadeOleo.DESCARTAR) return "Descartar";
  if (value === StatusQualidadeOleo.SEM_UTILIZACAO) return "Sem utilização";
  return "Adequado";
}

function labelStatusNota(value: StatusNotaRecebimento | null | undefined): string {
  if (value === StatusNotaRecebimento.FINALIZADA) return "Finalizada";
  if (value === StatusNotaRecebimento.IMPORTADA) return "Importada";
  if (value === StatusNotaRecebimento.EM_CONFERENCIA) return "Em conferência";
  return "Pendente";
}

function labelStatusRecebimento(value: StatusRecebimento): string {
  if (value === StatusRecebimento.CONFORME) return "Conforme";
  if (value === StatusRecebimento.NAO_CONFORME) return "Não conforme";
  return "Pendente";
}

function labelClassificacao(value: ClassificacaoItemBuffetAmostra): string {
  if (value === ClassificacaoItemBuffetAmostra.FRIO) return "Frios";
  if (value === ClassificacaoItemBuffetAmostra.TEMPERATURA_AMBIENTE) return "Temperatura Ambiente";
  return "Quentes";
}

function labelStatusBuffet(value: StatusItemBuffetAmostra): string {
  if (value === StatusItemBuffetAmostra.ASSINADO) return "Assinado";
  if (value === StatusItemBuffetAmostra.PREENCHIDO) return "Preenchido";
  if (value === StatusItemBuffetAmostra.NAO_SERVIDO) return "Não servido";
  return "Pendente";
}

function labelStatusChamado(value: StatusChamadoManutencao): string {
  if (value === StatusChamadoManutencao.EM_ANDAMENTO) return "Em andamento";
  if (value === StatusChamadoManutencao.CONCLUIDO) return "Concluído";
  if (value === StatusChamadoManutencao.CANCELADO) return "Cancelado";
  return "Aberto";
}

function labelOrigem(value: OrigemChamadoManutencao): string {
  if (value === OrigemChamadoManutencao.TEMPERATURA) return "Temperatura";
  if (value === OrigemChamadoManutencao.LIMPEZA) return "Limpeza";
  if (value === OrigemChamadoManutencao.OLEO) return "Óleo";
  if (value === OrigemChamadoManutencao.RECEBIMENTO) return "Recebimento";
  if (value === OrigemChamadoManutencao.HORTIFRUTI) return "Hortifruti";
  if (value === OrigemChamadoManutencao.BUFFET_AMOSTRAS) return "Buffet / Amostras";
  return "Manual / Outros";
}

function columns(items: Array<[string, string]>): ReportColumn[] {
  return items.map(([key, label]) => ({ key, label }));
}

function makeAppliedFilters(params: ReportSearchParams, moduleId: string, reportId: string): AppliedReportFilter[] {
  return getFiltersForReport(moduleId, reportId).flatMap((filter) => {
    const value = getParam(params, filter.key);
    if (!value) return [];
    const optionLabel = filter.options?.find((option) => option.value === value)?.label;
    return [{ label: filter.label, value: optionLabel ?? value }];
  });
}

function finalizeReport(params: {
  moduleId: ReportModuleId;
  reportId: string;
  searchParams: ReportSearchParams;
  user: AuthenticatedUser;
  periodLabel: string;
  summary: ReportSummaryItem[];
  columns: ReportColumn[];
  rows: ReportRow[];
  notes?: string[];
}): GeneratedReport {
  const moduleDefinition = getReportModule(params.moduleId);
  const reportDefinition = getReportDefinition(params.moduleId, params.reportId);
  return {
    moduleId: params.moduleId,
    moduleLabel: moduleDefinition.label,
    reportId: reportDefinition.id,
    reportLabel: reportDefinition.label,
    periodLabel: params.periodLabel,
    generatedBy: params.user.nomeCompleto,
    generatedByRole: getRoleLabel(params.user.perfil),
    generatedAt: getAppNow(),
    appliedFilters: makeAppliedFilters(params.searchParams, params.moduleId, reportDefinition.id),
    summary: params.summary,
    columns: params.columns,
    rows: params.rows,
    notes: params.notes
  };
}

function rangeFromWeek(params: ReportSearchParams): DateRange {
  const year = Number(getParam(params, "ano")) || getAppMonthYear(getAppDate()).ano;
  const week = Number(getParam(params, "semana"));
  const month = Number(getParam(params, "mes"));
  if (week && week >= 1 && week <= 53) {
    const firstWeekDate = parseAppDateInput(`${year}-01-01`) ?? getAppDate();
    const firstWeekStart = new Date(firstWeekDate);
    firstWeekStart.setUTCDate(firstWeekStart.getUTCDate() + (week - 1) * 7);
    const { start, end } = getAppWeekDateRange(firstWeekStart);
    return { start, end, startInput: formatDateInput(start), endInput: formatDateInput(end) };
  }
  if (month && month >= 1 && month <= 12) {
    const { start, end } = getAppMonthDateRange(month, year);
    return { start, end, startInput: formatDateInput(start), endInput: formatDateInput(end) };
  }
  return getDateRange(params);
}

async function generateHortifrutiReport(moduleId: ReportModuleId, reportId: string, params: ReportSearchParams, user: AuthenticatedUser) {
  const range = getDateRange(params);
  const records = await prisma.higienizacaoHortifruti.findMany({
    where: { data: { gte: range.start, lte: range.end } },
    orderBy: [{ data: "asc" }, { inicioProcesso: "asc" }]
  });
  const filtered = records.filter((item) => {
    const completo = hasText(item.hortifruti) && hasText(item.produtoUtilizado) && hasText(item.inicioProcesso) && hasText(item.terminoProcesso);
    if (reportId === "registros-observacao" && !hasText(item.observacoes)) return false;
    if (reportId === "pendencias-incompletos" && completo) return false;
    if (!includesText(item.hortifruti, getParam(params, "hortifruti"))) return false;
    if (!includesText(item.produtoUtilizado, getParam(params, "produtoUtilizado"))) return false;
    if (!includesText(item.responsavel, getParam(params, "responsavel"))) return false;
    if (!matchesYesNo(hasText(item.observacoes), getParam(params, "comObservacao"))) return false;
    const status = getParam(params, "statusHortifruti");
    if (status === "CONCLUIDO" && !completo) return false;
    if (status === "INCOMPLETO" && completo) return false;
    return true;
  });
  return finalizeReport({
    moduleId, reportId, searchParams: params, user, periodLabel: getPeriodLabel(range),
    summary: [
      { label: "Total de registros", value: filtered.length },
      { label: "Com observação", value: filtered.filter((item) => hasText(item.observacoes)).length },
      { label: "Incompletos", value: filtered.filter((item) => !hasText(item.inicioProcesso) || !hasText(item.terminoProcesso)).length }
    ],
    columns: columns([["data", "Data"], ["hortifruti", "Hortifruti"], ["produtoUtilizado", "Produto utilizado"], ["inicioProcesso", "Início"], ["terminoProcesso", "Término"], ["responsavel", "Responsável"], ["status", "Status"], ["observacao", "Observação"]]),
    rows: filtered.map((item) => ({ data: formatDateDisplay(item.data), hortifruti: item.hortifruti, produtoUtilizado: item.produtoUtilizado, inicioProcesso: item.inicioProcesso, terminoProcesso: item.terminoProcesso, responsavel: item.responsavel, status: hasText(item.inicioProcesso) && hasText(item.terminoProcesso) ? "Concluído" : "Incompleto", observacao: valueOrDash(item.observacoes) }))
  });
}

async function generateTemperaturaReport(moduleId: ReportModuleId, reportId: string, params: ReportSearchParams, user: AuthenticatedUser) {
  const range = getDateRange(params);
  const records = await prisma.controleTemperaturaEquipamento.findMany({ where: { data: { gte: range.start, lte: range.end } }, orderBy: [{ data: "asc" }, { createdAt: "asc" }] });
  const filtered = records.filter((item) => {
    const operacional = isTemperaturaOperacional(item.statusOperacionalEquipamento);
    const foraFaixa =
      operacional &&
      (item.status === StatusTemperaturaEquipamento.ALERTA ||
        item.status === StatusTemperaturaEquipamento.CRITICO);
    const temFoto =
      operacional &&
      hasImageEvidence({
        url: item.fotoUrl,
        mimeType: item.fotoMimeType,
        base64: item.fotoBase64
      });
    if (reportId === "fora-faixa" && !foraFaixa) return false;
    if (reportId === "acoes-corretivas" && !hasText(item.acaoCorretiva)) return false;
    if (reportId === "foto-obrigatoria" && !foraFaixa) return false;
    if (reportId === "pendencias-periodo" && (!foraFaixa || temFoto)) return false;
    if (!includesText(item.equipamento, getParam(params, "equipamento"))) return false;
    if (!includesText(item.responsavel, getParam(params, "responsavel"))) return false;
    const turno = getParam(params, "turnoTemperatura");
    if (turno && item.turno !== turno) return false;
    const status = getParam(params, "statusTemperatura");
    if (status && (!operacional || item.status !== status)) return false;
    const tempStatus = getParam(params, "temperaturaStatus");
    if (tempStatus === "NORMAL" && (!operacional || item.status !== StatusTemperaturaEquipamento.CONFORME)) return false;
    if (tempStatus === "ALERTA" && (!operacional || item.status !== StatusTemperaturaEquipamento.ALERTA)) return false;
    if (tempStatus === "CRITICA" && (!operacional || item.status !== StatusTemperaturaEquipamento.CRITICO)) return false;
    if (!matchesYesNo(hasText(item.acaoCorretiva), getParam(params, "acaoCorretiva"))) return false;
    if (!matchesYesNo(temFoto, getParam(params, "comFoto"))) return false;
    if (!matchesYesNo(foraFaixa && !temFoto, getParam(params, "semFotoObrigatoria"))) return false;
    return true;
  });
  return finalizeReport({
    moduleId, reportId, searchParams: params, user, periodLabel: getPeriodLabel(range),
    summary: [
      { label: "Total de registros", value: filtered.length },
      { label: "Fora da faixa", value: filtered.filter((item) => isTemperaturaOperacional(item.statusOperacionalEquipamento) && item.status !== StatusTemperaturaEquipamento.CONFORME).length },
      { label: "Com ação corretiva", value: filtered.filter((item) => hasText(item.acaoCorretiva)).length },
      {
        label: "Com foto",
        value: filtered.filter((item) =>
          hasImageEvidence({
            url: item.fotoUrl,
            mimeType: item.fotoMimeType,
            base64: item.fotoBase64
          })
        ).length
      }
    ],
    columns: columns([["data", "Data"], ["equipamento", "Equipamento"], ["turno", "Turno"], ["statusOperacional", "Status operacional"], ["temperatura", "Temperatura"], ["status", "Status"], ["acaoCorretiva", "Ação corretiva"], ["foto", "Foto"], ["responsavel", "Responsável"], ["dataHoraRegistro", "Data/hora do registro"]]),
    rows: filtered.map((item) => {
      const operacional = isTemperaturaOperacional(item.statusOperacionalEquipamento);
      const temFoto = hasImageEvidence({
        url: item.fotoUrl,
        mimeType: item.fotoMimeType,
        base64: item.fotoBase64
      });
      return { data: formatDateDisplay(item.data), equipamento: item.equipamento, turno: labelTurnoTemperatura(item.turno), statusOperacional: labelStatusOperacionalTemperatura(item.statusOperacionalEquipamento), temperatura: operacional ? formatTemperature(item.temperaturaAferida) : "Não aplicável", status: operacional ? labelStatusTemperatura(item.status) : "Não aplicável", acaoCorretiva: operacional ? valueOrDash(item.acaoCorretiva) : "-", foto: operacional && temFoto ? "Foto anexada" : "-", responsavel: item.responsavel, dataHoraRegistro: formatDateTimeDisplay(item.createdAt) };
    })
  });
}

async function generateOleoReport(moduleId: ReportModuleId, reportId: string, params: ReportSearchParams, user: AuthenticatedUser) {
  const range = getDateRange(params);
  const records = await prisma.controleQualidadeOleoRegistro.findMany({ where: { data: { gte: range.start, lte: range.end } }, orderBy: [{ data: "asc" }, { createdAt: "asc" }] });
  const temperaturaFiltro = parseNumber(getParam(params, "temperatura"));
  const filtered = records.filter((item) => {
    if (reportId === "temperatura-oleo" && item.temperatura === null) return false;
    if (reportId === "sem-uso" && !item.semUtilizacao) return false;
    if (reportId === "acoes-corretivas" && (item.status === StatusQualidadeOleo.ADEQUADO || item.status === StatusQualidadeOleo.SEM_UTILIZACAO)) return false;
    if (!includesText(item.fitaOleo, getParam(params, "fita"))) return false;
    if (!includesText(item.responsavel, getParam(params, "responsavel"))) return false;
    if (!sameNumber(item.temperatura, temperaturaFiltro)) return false;
    const status = getParam(params, "statusOleo");
    if (status && item.status !== status) return false;
    const uso = getParam(params, "usoEquipamento");
    if (uso === "UTILIZADO" && item.semUtilizacao) return false;
    if (uso === "SEM_USO" && !item.semUtilizacao) return false;
    if (!matchesYesNo(hasText(item.observacao), getParam(params, "comObservacao"))) return false;
    return true;
  });
  return finalizeReport({
    moduleId, reportId, searchParams: params, user, periodLabel: getPeriodLabel(range),
    summary: [
      { label: "Total de registros", value: filtered.length },
      { label: "Sem utilização", value: filtered.filter((item) => item.semUtilizacao).length },
      { label: "Temperatura crítica", value: filtered.filter((item) => item.temperaturaCritica).length },
      { label: "Exigem acompanhamento", value: filtered.filter((item) => item.status !== StatusQualidadeOleo.ADEQUADO && item.status !== StatusQualidadeOleo.SEM_UTILIZACAO).length }
    ],
    columns: columns([["data", "Data"], ["equipamento", "Equipamento"], ["fita", "Fita"], ["temperatura", "Temperatura"], ["status", "Status"], ["observacao", "Observação / ação"], ["responsavel", "Responsável"]]),
    rows: filtered.map((item) => ({ data: formatDateDisplay(item.data), equipamento: item.semUtilizacao ? "Inutilizado / sem uso" : "Não informado no cadastro atual", fita: valueOrDash(item.fitaOleo), temperatura: formatTemperature(item.temperatura), status: labelStatusOleo(item.status), observacao: valueOrDash(item.observacao?.trim() || item.orientacao), responsavel: item.responsavel })),
    notes: ["O modelo atual do Controle de Qualidade do Óleo não possui campo de equipamento individual; o relatório indica uso/sem uso quando disponível."]
  });
}

async function generateRecebimentoReport(moduleId: ReportModuleId, reportId: string, params: ReportSearchParams, user: AuthenticatedUser) {
  const range = getDateRange(params);
  const records = await prisma.rastreabilidadeRecebimentoRegistro.findMany({ where: { data: { gte: range.start, lte: range.end } }, include: { nota: true }, orderBy: [{ data: "asc" }, { fornecedor: "asc" }, { produto: "asc" }] });
  const temperaturaFiltro = parseNumber(getParam(params, "temperatura"));
  const filtered = records.filter((item) => {
    const statusNota = item.nota?.statusNota ?? StatusNotaRecebimento.PENDENTE;
    const sifIsNa = isSifNaValue(item.sif);
    if (reportId === "notas-pendentes" && statusNota === StatusNotaRecebimento.FINALIZADA) return false;
    if (reportId === "produtos-nao-conformes" && item.statusGeral !== StatusRecebimento.NAO_CONFORME) return false;
    if (reportId === "produtos-sif-na" && !hasText(item.sif) && !sifIsNa) return false;
    if (!includesText(item.fornecedor, getParam(params, "fornecedor"))) return false;
    if (!includesText(item.notaFiscal, getParam(params, "notaFiscal"))) return false;
    if (!includesText(item.produto, getParam(params, "produto"))) return false;
    if (!includesText(item.lote, getParam(params, "lote"))) return false;
    if (!includesText(formatSifDisplayValue(item.sif, ""), getParam(params, "sif"))) return false;
    if (!sameNumber(item.temperatura, temperaturaFiltro)) return false;
    if (!matchesYesNo(sifIsNa, getParam(params, "sifNa"))) return false;
    const transporte = getParam(params, "transporte");
    if (transporte && item.transporteEntregador !== transporte) return false;
    const aspecto = getParam(params, "aspecto");
    if (aspecto && item.aspectoSensorial !== aspecto) return false;
    const embalagem = getParam(params, "embalagem");
    if (embalagem && item.embalagem !== embalagem) return false;
    if (!includesText(item.responsavelRecebimento, getParam(params, "responsavelConferencia"))) return false;
    const statusNotaFiltro = getParam(params, "statusNota");
    if (statusNotaFiltro && statusNota !== statusNotaFiltro) return false;
    if (!matchesYesNo(hasText(item.acaoCorretiva), getParam(params, "acaoCorretiva"))) return false;
    return true;
  });
  return finalizeReport({
    moduleId, reportId, searchParams: params, user, periodLabel: getPeriodLabel(range),
    summary: [
      { label: "Total de itens", value: filtered.length },
      { label: "Notas distintas", value: new Set(filtered.map((item) => item.notaId ?? item.notaFiscal)).size },
      { label: "Não conformes", value: filtered.filter((item) => item.statusGeral === StatusRecebimento.NAO_CONFORME).length },
      { label: "Com ação corretiva", value: filtered.filter((item) => hasText(item.acaoCorretiva)).length }
    ],
    columns: columns([["dataNota", "Data da nota"], ["fornecedor", "Fornecedor"], ["notaFiscal", "Número da nota"], ["produto", "Produto"], ["codigoProduto", "Código produto"], ["ncm", "NCM"], ["cfop", "CFOP"], ["quantidadeComprada", "Quantidade comprada"], ["unidadeMedidaCompra", "Unidade"], ["valorUnitario", "Valor unitário"], ["valorTotalItem", "Valor total item"], ["lote", "Lote"], ["fabricacao", "Data de fabricação"], ["validade", "Validade"], ["sif", "SIF"], ["temperatura", "Temperatura"], ["transporte", "Transporte"], ["aspecto", "Aspecto"], ["embalagem", "Embalagem"], ["acaoCorretiva", "Ação corretiva"], ["responsavel", "Responsável"], ["status", "Status"]]),
    rows: filtered.map((item) => ({ dataNota: formatDateDisplay(item.data), fornecedor: item.fornecedor, notaFiscal: item.notaFiscal, produto: item.produto, codigoProduto: valueOrDash(item.codigoProdutoXml), ncm: valueOrDash(item.ncm), cfop: valueOrDash(item.cfop), quantidadeComprada: formatNumber(item.quantidadeComprada), unidadeMedidaCompra: valueOrDash(item.unidadeMedidaCompra), valorUnitario: formatCurrency(item.valorUnitario), valorTotalItem: formatCurrency(item.valorTotalItem), lote: valueOrDash(item.lote), fabricacao: formatDateDisplay(item.dataFabricacao), validade: formatRecebimentoValidade(item.dataValidade, item.validadeNaoAplicavel), sif: formatSifDisplayValue(item.sif), temperatura: formatRecebimentoTemperatura(item.temperatura, item.temperaturaTipo), transporte: labelConformidade(item.transporteEntregador), aspecto: labelConformidade(item.aspectoSensorial), embalagem: labelConformidade(item.embalagem), acaoCorretiva: valueOrDash(item.acaoCorretiva), responsavel: valueOrDash(item.responsavelRecebimento), status: `${labelStatusRecebimento(item.statusGeral)} / Nota ${labelStatusNota(item.nota?.statusNota)}` }))
  });
}

async function generateBuffetReport(moduleId: ReportModuleId, reportId: string, params: ReportSearchParams, user: AuthenticatedUser) {
  const range = getDateRange(params);
  const records = await prisma.controleBuffetAmostraRegistro.findMany({ where: { data: { gte: range.start, lte: range.end } }, include: { servico: true }, orderBy: [{ data: "asc" }, { dataHoraRegistro: "asc" }] });
  const statusFilter = getParam(params, "statusBuffet");
  const filtered = records.filter((item) => {
    const naoServido = item.status === StatusItemBuffetAmostra.NAO_SERVIDO;
    const foraRegra = !naoServido && (item.statusTemperatura === StatusTemperaturaBuffetAmostra.ALERTA || item.statusTemperatura === StatusTemperaturaBuffetAmostra.CRITICO);
    const descarte = !naoServido && (normalize(item.acaoCorretiva).includes("descart") || normalize(item.observacao).includes("descart"));
    if (reportId === "itens-servidos" && naoServido) return false;
    if (!statusFilter && naoServido) return false;
    if (reportId === "itens-extras" && !item.itemExtra) return false;
    if (reportId === "temperaturas-fora-regra" && !foraRegra) return false;
    if (reportId === "acoes-corretivas" && !hasText(item.acaoCorretiva)) return false;
    if (reportId === "alimentos-descartados" && !descarte) return false;
    if (!includesText(item.servico.nome, getParam(params, "servico"))) return false;
    const tipoServico = getParam(params, "tipoServicoBuffet");
    if (tipoServico && item.servico.tipoServico !== tipoServico) return false;
    if (!includesText(item.itemNome, getParam(params, "item"))) return false;
    const classificacao = getParam(params, "classificacao");
    if (classificacao && item.classificacao !== classificacao) return false;
    const itemExtra = getParam(params, "itemExtra");
    if (itemExtra === "PADRAO" && item.itemExtra) return false;
    if (itemExtra === "EXTRA" && !item.itemExtra) return false;
    if (!matchesYesNo(hasText(item.acaoCorretiva), getParam(params, "acaoCorretiva"))) return false;
    if (!includesText(item.responsavelNome, getParam(params, "responsavel"))) return false;
    if (statusFilter && item.status !== statusFilter) return false;
    if (!matchesYesNo(foraRegra, getParam(params, "temperaturaForaRegra"))) return false;
    return true;
  });
  return finalizeReport({
    moduleId, reportId, searchParams: params, user, periodLabel: getPeriodLabel(range),
    summary: [
      { label: "Total de registros", value: filtered.length },
      { label: "Itens extras", value: filtered.filter((item) => item.itemExtra).length },
      { label: "Temperatura fora da regra", value: filtered.filter((item) => item.statusTemperatura === StatusTemperaturaBuffetAmostra.ALERTA || item.statusTemperatura === StatusTemperaturaBuffetAmostra.CRITICO).length },
      { label: "Com ação corretiva", value: filtered.filter((item) => hasText(item.acaoCorretiva)).length }
    ],
    columns: columns([["data", "Data"], ["servico", "Serviço"], ["tipoServico", "Tipo de serviço"], ["periodoServico", "Período do serviço"], ["item", "Item"], ["classificacao", "Classificação"], ["tcEquipamento", "TC equipamento"], ["primeiraTc", "TC alimento"], ["acaoCorretiva", "Ação corretiva"], ["observacao", "Observação"], ["responsavel", "Executor"], ["supervisor", "Supervisor"], ["dataHoraAssinatura", "Data/hora da supervisão"], ["status", "Status"]]),
    rows: filtered.map((item) => {
      const naoServido = item.status === StatusItemBuffetAmostra.NAO_SERVIDO;
      const temperaturaLabel = naoServido
        ? "-"
        : item.temperaturaAmbiente
          ? "Ambiente"
          : null;
      return { data: formatDateDisplay(item.data), servico: item.servico.nome, tipoServico: getTipoServicoLabel(item.servico.tipoServico), periodoServico: getServicoPeriodoLabel(item.servico), item: `${item.itemNome}${item.itemExtra ? " (extra)" : ""}`, classificacao: labelClassificacao(item.classificacao), tcEquipamento: temperaturaLabel ?? formatTemperature(item.tcEquipamento), primeiraTc: temperaturaLabel ?? formatTemperature(item.primeiraTc), acaoCorretiva: valueOrDash(item.acaoCorretiva), observacao: valueOrDash(item.observacao), responsavel: item.responsavelNome, supervisor: valueOrDash(item.assinaturaNome), dataHoraAssinatura: formatDateTimeDisplay(item.assinaturaDataHora), status: labelStatusBuffet(item.status) };
    })
  });
}

async function generateDiarioReport(moduleId: ReportModuleId, reportId: string, params: ReportSearchParams, user: AuthenticatedUser) {
  const range = getDateRange(params);
  const [records, areaConfigs] = await Promise.all([
    prisma.planoLimpezaDiarioRegistro.findMany({ where: { data: { gte: range.start, lte: range.end } }, orderBy: [{ data: "asc" }, { area: "asc" }, { turno: "asc" }] }),
    prisma.planoLimpezaDiarioArea.findMany({
      select: {
        nome: true,
        detalhamentoLimpeza: true
      }
    })
  ]);
  const detalhamentoPorArea = new Map(
    areaConfigs.map((item) => [item.nome, item.detalhamentoLimpeza])
  );
  const filtered = records.filter((item) => {
    if (reportId === "pendencias" && item.status !== StatusPlanoLimpeza.PENDENTE) return false;
    if (reportId === "aguardando-supervisor" && item.status !== StatusPlanoLimpeza.AGUARDANDO_SUPERVISOR) return false;
    if (!includesText(item.area, getParam(params, "area"))) return false;
    const turno = getParam(params, "turnoLimpeza");
    if (turno && item.turno !== turno) return false;
    if (!includesText(item.assinaturaResponsavel, getParam(params, "responsavel"))) return false;
    if (!includesText(item.assinaturaSupervisor, getParam(params, "supervisor"))) return false;
    const status = getParam(params, "statusPlanoLimpeza");
    if (status && item.status !== status) return false;
    return true;
  });
  return finalizeReport({
    moduleId, reportId, searchParams: params, user, periodLabel: getPeriodLabel(range),
    summary: [
      { label: "Total de execuções", value: filtered.length },
      { label: "Pendentes", value: filtered.filter((item) => item.status === StatusPlanoLimpeza.PENDENTE).length },
      { label: "Aguardando supervisor", value: filtered.filter((item) => item.status === StatusPlanoLimpeza.AGUARDANDO_SUPERVISOR).length },
      { label: "Concluídas", value: filtered.filter((item) => item.status === StatusPlanoLimpeza.CONCLUIDO).length }
    ],
    columns: columns([["data", "Data"], ["area", "Área"], ["item", "Item/local"], ["produto", "Produto"], ["setorResponsavel", "Setor responsável"], ["funcionarioResponsavel", "Funcionário responsável"], ["detalhamentoLimpeza", "Orientação geral"], ["turno", "Turno"], ["responsavel", "Responsável"], ["dataHoraResponsavel", "Data/hora da assinatura"], ["supervisor", "Supervisor"], ["status", "Status"], ["observacao", "Observação"]]),
    rows: filtered.map((item) => ({ data: formatDateDisplay(item.data), area: item.area, item: valueOrDash(item.itemDescricao ?? item.area), produto: valueOrDash(item.produtoUtilizado), setorResponsavel: valueOrDash(item.setorResponsavel), funcionarioResponsavel: valueOrDash(item.funcionarioResponsavel), detalhamentoLimpeza: valueOrDash(detalhamentoPorArea.get(item.area)), turno: labelTurnoLimpeza(item.turno), responsavel: valueOrDash(item.assinaturaResponsavel), dataHoraResponsavel: formatDateTimeDisplay(item.assinaturaResponsavelDataHora), supervisor: valueOrDash(item.assinaturaSupervisor), status: labelStatusPlano(item.status), observacao: valueOrDash(item.observacao ?? item.observacaoResponsavel ?? item.observacaoSupervisor) }))
  });
}

async function generateSemanalReport(moduleId: ReportModuleId, reportId: string, params: ReportSearchParams, user: AuthenticatedUser) {
  const range = rangeFromWeek(params);
  const records = await prisma.planoLimpezaSemanalExecucao.findMany({ where: { dataExecucao: { gte: range.start, lte: range.end } }, include: { item: true }, orderBy: [{ dataExecucao: "asc" }, { area: "asc" }] });
  const filtered = records.filter((item) => {
    if (reportId === "pendencias" && item.status !== StatusPlanoLimpeza.PENDENTE) return false;
    if (reportId === "aguardando-supervisor" && item.status !== StatusPlanoLimpeza.AGUARDANDO_SUPERVISOR) return false;
    if (!includesText(item.area, getParam(params, "area"))) return false;
    if (!includesText(item.itemDescricao ?? item.item.oQueLimpar, getParam(params, "item"))) return false;
    if (!includesText(item.assinaturaResponsavel, getParam(params, "responsavel"))) return false;
    if (!includesText(item.assinaturaSupervisor, getParam(params, "supervisor"))) return false;
    const status = getParam(params, "statusPlanoLimpeza");
    if (status && item.status !== status) return false;
    return true;
  });
  return finalizeReport({
    moduleId, reportId, searchParams: params, user, periodLabel: getPeriodLabel(range),
    summary: [
      { label: "Total de execuções", value: filtered.length },
      { label: "Pendentes", value: filtered.filter((item) => item.status === StatusPlanoLimpeza.PENDENTE).length },
      { label: "Aguardando supervisor", value: filtered.filter((item) => item.status === StatusPlanoLimpeza.AGUARDANDO_SUPERVISOR).length },
      { label: "Concluídas", value: filtered.filter((item) => item.status === StatusPlanoLimpeza.CONCLUIDO).length }
    ],
    columns: columns([["semana", "Semana"], ["area", "Área"], ["item", "Item"], ["produto", "Produto"], ["quando", "Quando"], ["setorResponsavel", "Setor responsável"], ["funcionarioResponsavel", "Funcionário responsável"], ["responsavel", "Responsável pela execução"], ["supervisor", "Supervisor"], ["status", "Status"], ["observacao", "Observação"]]),
    rows: filtered.map((item) => ({ semana: formatDateDisplay(item.dataExecucao), area: item.area, item: item.itemDescricao ?? item.item.oQueLimpar, produto: valueOrDash(item.qualProduto ?? item.item.qualProduto), quando: formatWeeklyExecutionQuando(item), setorResponsavel: valueOrDash(item.setorResponsavel ?? item.item.setorResponsavel), funcionarioResponsavel: valueOrDash(item.funcionarioResponsavel ?? item.item.quem), responsavel: valueOrDash(item.assinaturaResponsavel), supervisor: valueOrDash(item.assinaturaSupervisor), status: labelStatusPlano(item.status), observacao: valueOrDash(item.observacaoResponsavel ?? item.observacaoSupervisor) }))
  });
}

async function generateChamadosReport(moduleId: ReportModuleId, reportId: string, params: ReportSearchParams, user: AuthenticatedUser) {
  const range = getDateRange(params);
  const dateTimeRange = getDateTimeRange(params);
  const records = await prisma.chamadoManutencao.findMany({ where: { dataHoraCriacao: { gte: dateTimeRange.start, lte: dateTimeRange.end } }, orderBy: [{ dataHoraCriacao: "asc" }] });
  const filtered = records.filter((item) => {
    if (reportId === "chamados-pendentes" && (item.status === StatusChamadoManutencao.CONCLUIDO || item.status === StatusChamadoManutencao.CANCELADO)) return false;
    if (reportId === "chamados-concluidos" && item.status !== StatusChamadoManutencao.CONCLUIDO) return false;
    const origem = getParam(params, "origem");
    if (origem && item.origem !== origem) return false;
    if (!includesText(item.criadoPorNome, getParam(params, "usuario"))) return false;
    const status = getParam(params, "statusChamado");
    if (status && item.status !== status) return false;
    if (!matchesYesNo(hasText(item.fotoBase64), getParam(params, "comFoto"))) return false;
    const situacao = getParam(params, "chamadoSituacao");
    if (situacao === "CONCLUIDO" && item.status !== StatusChamadoManutencao.CONCLUIDO) return false;
    if (situacao === "PENDENTE" && (item.status === StatusChamadoManutencao.CONCLUIDO || item.status === StatusChamadoManutencao.CANCELADO)) return false;
    return true;
  });
  return finalizeReport({
    moduleId, reportId, searchParams: params, user, periodLabel: getPeriodLabel(range),
    summary: [
      { label: "Total de chamados", value: filtered.length },
      { label: "Pendentes", value: filtered.filter((item) => item.status === StatusChamadoManutencao.ABERTO || item.status === StatusChamadoManutencao.EM_ANDAMENTO).length },
      { label: "Concluídos", value: filtered.filter((item) => item.status === StatusChamadoManutencao.CONCLUIDO).length },
      { label: "Com foto", value: filtered.filter((item) => hasText(item.fotoBase64)).length }
    ],
    columns: columns([["dataHora", "Data/hora"], ["origem", "Origem"], ["usuario", "Usuário"], ["titulo", "Título"], ["observacao", "Observação"], ["foto", "Foto"], ["status", "Status"], ["responsavelTratativa", "Responsável pela tratativa"], ["dataConclusao", "Data de conclusão"]]),
    rows: filtered.map((item) => ({ dataHora: formatDateTimeDisplay(item.dataHoraCriacao), origem: labelOrigem(item.origem), usuario: item.criadoPorNome, titulo: item.titulo, observacao: item.descricao, foto: hasText(item.fotoBase64) ? "Foto anexada" : "-", status: labelStatusChamado(item.status), responsavelTratativa: "Não informado no cadastro atual", dataConclusao: formatDateTimeDisplay(item.dataHoraConclusao) })),
    notes: ["O modelo atual de chamados não possui campo específico de responsável pela tratativa; a coluna fica marcada como não informada."]
  });
}

async function countGeneralModuleRows(range: DateRange) {
  const dateTimeEnd = getEndOfAppDay(range.end);
  const [hort, temp, oleo, receb, buffet, diario, semanal, chamados] = await Promise.all([
    prisma.higienizacaoHortifruti.findMany({ where: { data: { gte: range.start, lte: range.end } } }),
    prisma.controleTemperaturaEquipamento.findMany({ where: { data: { gte: range.start, lte: range.end } } }),
    prisma.controleQualidadeOleoRegistro.findMany({ where: { data: { gte: range.start, lte: range.end } } }),
    prisma.rastreabilidadeRecebimentoRegistro.findMany({ where: { data: { gte: range.start, lte: range.end } } }),
    prisma.controleBuffetAmostraRegistro.findMany({ where: { data: { gte: range.start, lte: range.end } } }),
    prisma.planoLimpezaDiarioRegistro.findMany({ where: { data: { gte: range.start, lte: range.end } } }),
    prisma.planoLimpezaSemanalExecucao.findMany({ where: { dataExecucao: { gte: range.start, lte: range.end } } }),
    prisma.chamadoManutencao.findMany({ where: { dataHoraCriacao: { gte: range.start, lte: dateTimeEnd } } })
  ]);
  const tempOperacionais = temp.filter((item) =>
    isTemperaturaOperacional(item.statusOperacionalEquipamento)
  );
  const buffetColetados = buffet.filter(
    (item) => item.status !== StatusItemBuffetAmostra.NAO_SERVIDO
  );
  return [
    { id: "higienizacao-hortifruti", modulo: "Higienização de Hortifruti", total: hort.length, pendencias: hort.filter((item) => !hasText(item.inicioProcesso) || !hasText(item.terminoProcesso)).length, concluidos: hort.length, naoConformidades: 0, acoesCorretivas: 0, semAssinatura: 0, chamadosAbertos: 0, chamadosConcluidos: 0 },
    { id: "controle-temperatura-equipamentos", modulo: "Controle de Temperatura", total: temp.length, pendencias: tempOperacionais.filter((item) => (item.status === StatusTemperaturaEquipamento.ALERTA || item.status === StatusTemperaturaEquipamento.CRITICO) && !hasImageEvidence({ url: item.fotoUrl, mimeType: item.fotoMimeType, base64: item.fotoBase64 })).length, concluidos: temp.filter((item) => !isTemperaturaOperacional(item.statusOperacionalEquipamento) || item.status === StatusTemperaturaEquipamento.CONFORME).length, naoConformidades: tempOperacionais.filter((item) => item.status !== StatusTemperaturaEquipamento.CONFORME).length, acoesCorretivas: tempOperacionais.filter((item) => hasText(item.acaoCorretiva)).length, semAssinatura: 0, chamadosAbertos: 0, chamadosConcluidos: 0 },
    { id: "controle-qualidade-oleo", modulo: "Controle de Qualidade do Óleo", total: oleo.length, pendencias: oleo.filter((item) => item.status === StatusQualidadeOleo.DESCARTAR || item.status === StatusQualidadeOleo.ULTIMA_UTILIZACAO).length, concluidos: oleo.filter((item) => item.status === StatusQualidadeOleo.ADEQUADO || item.status === StatusQualidadeOleo.SEM_UTILIZACAO).length, naoConformidades: oleo.filter((item) => item.status !== StatusQualidadeOleo.ADEQUADO && item.status !== StatusQualidadeOleo.SEM_UTILIZACAO).length, acoesCorretivas: oleo.filter((item) => item.status === StatusQualidadeOleo.DESCARTAR || item.status === StatusQualidadeOleo.ATENCAO || item.status === StatusQualidadeOleo.ULTIMA_UTILIZACAO).length, semAssinatura: 0, chamadosAbertos: 0, chamadosConcluidos: 0 },
    { id: "rastreabilidade-recebimento", modulo: "Rastreabilidade de Recebimento", total: receb.length, pendencias: receb.filter((item) => item.statusGeral === StatusRecebimento.PENDENTE).length, concluidos: receb.filter((item) => item.statusGeral === StatusRecebimento.CONFORME).length, naoConformidades: receb.filter((item) => item.statusGeral === StatusRecebimento.NAO_CONFORME).length, acoesCorretivas: receb.filter((item) => hasText(item.acaoCorretiva)).length, semAssinatura: receb.filter((item) => !hasText(item.responsavelRecebimento)).length, chamadosAbertos: 0, chamadosConcluidos: 0 },
    { id: "controle-buffet-amostras", modulo: "Controle de Buffet / Amostras", total: buffetColetados.length, pendencias: buffetColetados.filter((item) => item.status === StatusItemBuffetAmostra.PENDENTE).length, concluidos: buffetColetados.filter((item) => item.status === StatusItemBuffetAmostra.PREENCHIDO || item.status === StatusItemBuffetAmostra.ASSINADO).length, naoConformidades: buffetColetados.filter((item) => item.statusTemperatura === StatusTemperaturaBuffetAmostra.ALERTA || item.statusTemperatura === StatusTemperaturaBuffetAmostra.CRITICO).length, acoesCorretivas: buffetColetados.filter((item) => hasText(item.acaoCorretiva)).length, semAssinatura: buffetColetados.filter((item) => !hasText(item.assinaturaNome)).length, chamadosAbertos: 0, chamadosConcluidos: 0 },
    { id: "plano-limpeza-diario", modulo: "Plano de Limpeza Diário", total: diario.length, pendencias: diario.filter((item) => item.status !== StatusPlanoLimpeza.CONCLUIDO).length, concluidos: diario.filter((item) => item.status === StatusPlanoLimpeza.CONCLUIDO).length, naoConformidades: 0, acoesCorretivas: 0, semAssinatura: diario.filter((item) => item.status !== StatusPlanoLimpeza.CONCLUIDO).length, chamadosAbertos: 0, chamadosConcluidos: 0 },
    { id: "plano-limpeza-semanal", modulo: "Plano de Limpeza Semanal", total: semanal.length, pendencias: semanal.filter((item) => item.status !== StatusPlanoLimpeza.CONCLUIDO).length, concluidos: semanal.filter((item) => item.status === StatusPlanoLimpeza.CONCLUIDO).length, naoConformidades: 0, acoesCorretivas: 0, semAssinatura: semanal.filter((item) => item.status !== StatusPlanoLimpeza.CONCLUIDO).length, chamadosAbertos: 0, chamadosConcluidos: 0 },
    { id: "chamados-manutencao", modulo: "Chamados de Manutenção", total: chamados.length, pendencias: chamados.filter((item) => item.status === StatusChamadoManutencao.ABERTO || item.status === StatusChamadoManutencao.EM_ANDAMENTO).length, concluidos: chamados.filter((item) => item.status === StatusChamadoManutencao.CONCLUIDO).length, naoConformidades: 0, acoesCorretivas: 0, semAssinatura: 0, chamadosAbertos: chamados.filter((item) => item.status === StatusChamadoManutencao.ABERTO || item.status === StatusChamadoManutencao.EM_ANDAMENTO).length, chamadosConcluidos: chamados.filter((item) => item.status === StatusChamadoManutencao.CONCLUIDO).length }
  ];
}

async function generateGeneralReport(moduleId: ReportModuleId, reportId: string, params: ReportSearchParams, user: AuthenticatedUser) {
  const range = getDateRange(params);
  const moduloEscopo = getParam(params, "moduloEscopo");
  const rowsRaw = (await countGeneralModuleRows(range)).filter((item) => {
    if (moduloEscopo && item.id !== moduloEscopo) return false;
    const status = getParam(params, "statusAuditoria");
    if (status === "PENDENTE" && item.pendencias === 0) return false;
    if (status === "CONCLUIDO" && item.concluidos === 0) return false;
    if (status === "NAO_CONFORME" && item.naoConformidades === 0) return false;
    if (!matchesYesNo(item.naoConformidades > 0, getParam(params, "naoConformidade"))) return false;
    if (!matchesYesNo(item.acoesCorretivas > 0, getParam(params, "acaoCorretiva"))) return false;
    const assinatura = getParam(params, "assinaturaStatus");
    if (assinatura === "ASSINADO" && item.semAssinatura > 0) return false;
    if (assinatura === "NAO_ASSINADO" && item.semAssinatura === 0) return false;
    return true;
  });
  const total = rowsRaw.reduce((sum, item) => sum + item.total, 0);
  const pendencias = rowsRaw.reduce((sum, item) => sum + item.pendencias, 0);
  const concluidos = rowsRaw.reduce((sum, item) => sum + item.concluidos, 0);
  const naoConformidades = rowsRaw.reduce((sum, item) => sum + item.naoConformidades, 0);
  const acoesCorretivas = rowsRaw.reduce((sum, item) => sum + item.acoesCorretivas, 0);
  const semAssinatura = rowsRaw.reduce((sum, item) => sum + item.semAssinatura, 0);
  const chamadosAbertos = rowsRaw.reduce((sum, item) => sum + item.chamadosAbertos, 0);
  const chamadosConcluidos = rowsRaw.reduce((sum, item) => sum + item.chamadosConcluidos, 0);
  return finalizeReport({
    moduleId, reportId, searchParams: params, user, periodLabel: getPeriodLabel(range),
    summary: [
      { label: "Total de registros", value: total }, { label: "Total de pendências", value: pendencias },
      { label: "Total concluído", value: concluidos }, { label: "Não conformidades", value: naoConformidades },
      { label: "Ações corretivas", value: acoesCorretivas }, { label: "Sem assinatura", value: semAssinatura },
      { label: "Chamados abertos", value: chamadosAbertos }, { label: "Chamados concluídos", value: chamadosConcluidos }
    ],
    columns: columns([["modulo", "Módulo"], ["total", "Total"], ["pendencias", "Pendências"], ["concluidos", "Concluídos"], ["naoConformidades", "Não conformidades"], ["acoesCorretivas", "Ações corretivas"], ["semAssinatura", "Sem assinatura"]]),
    rows: rowsRaw.map((item) => ({ modulo: item.modulo, total: item.total, pendencias: item.pendencias, concluidos: item.concluidos, naoConformidades: item.naoConformidades, acoesCorretivas: item.acoesCorretivas, semAssinatura: item.semAssinatura }))
  });
}

export async function generateReport(params: { moduleId: string; reportId: string; searchParams: ReportSearchParams; user: AuthenticatedUser }): Promise<GeneratedReport> {
  const moduleDefinition = getReportModule(params.moduleId);
  const reportDefinition = getReportDefinition(moduleDefinition.id, params.reportId);
  if (moduleDefinition.id === "geral") return generateGeneralReport(moduleDefinition.id, reportDefinition.id, params.searchParams, params.user);
  if (moduleDefinition.id === "higienizacao-hortifruti") return generateHortifrutiReport(moduleDefinition.id, reportDefinition.id, params.searchParams, params.user);
  if (moduleDefinition.id === "controle-temperatura-equipamentos") return generateTemperaturaReport(moduleDefinition.id, reportDefinition.id, params.searchParams, params.user);
  if (moduleDefinition.id === "controle-qualidade-oleo") return generateOleoReport(moduleDefinition.id, reportDefinition.id, params.searchParams, params.user);
  if (moduleDefinition.id === "rastreabilidade-recebimento") return generateRecebimentoReport(moduleDefinition.id, reportDefinition.id, params.searchParams, params.user);
  if (moduleDefinition.id === "controle-buffet-amostras") return generateBuffetReport(moduleDefinition.id, reportDefinition.id, params.searchParams, params.user);
  if (moduleDefinition.id === "plano-limpeza-diario") return generateDiarioReport(moduleDefinition.id, reportDefinition.id, params.searchParams, params.user);
  if (moduleDefinition.id === "plano-limpeza-semanal") return generateSemanalReport(moduleDefinition.id, reportDefinition.id, params.searchParams, params.user);
  return generateChamadosReport(moduleDefinition.id, reportDefinition.id, params.searchParams, params.user);
}
