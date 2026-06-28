import {
  ModuloDocumento,
  Prisma,
  StatusFechamentoTemperaturaEquipamento,
  StatusOperacionalEquipamento,
  StatusTemperaturaEquipamento,
  TipoOpcaoTemperaturaEquipamento,
  TurnoTemperaturaEquipamento
} from "@prisma/client";
import Link from "next/link";

import { DocumentosModuleHeader } from "@/components/documentos/documentos-module-header";
import { ImageUploadField } from "@/components/forms/image-upload-field";
import { ActionModal, ModalActions } from "@/components/ui/action-modal";
import { getCurrentUser } from "@/lib/auth-session";
import {
  getImageDataUrl,
  getStoredImageSrc,
  hasStoredImage as hasImageEvidence
} from "@/lib/image-upload";
import {
  TEMPERATURE_EVIDENCE_IMAGE_MAX_BYTES,
  TEMPERATURE_EVIDENCE_IMAGE_MAX_WIDTH,
  TEMPERATURE_EVIDENCE_IMAGE_TARGET_BYTES
} from "@/lib/image-upload-rules";
import { hasPermission } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";

import {
  createRegistroAction,
  deleteRegistroAction,
  updateRegistroAction
} from "./actions";
import { AutomaticCorrectiveActionFields } from "./automatic-corrective-action-fields";
import { EvidencePhoto } from "./evidence-photo";
import { normalizeOption } from "./options";
import { TemperatureStatusBadge } from "./temperature-status-badge";
import {
  formatDateInput,
  formatDateDisplay,
  formatDateTimeDisplay,
  formatTemperatureDisplay,
  getCurrentShift,
  getCurrentSystemDateTime,
  getMonthDateRange,
  getMonthYear,
  getOperationalStatusLabel,
  getShiftLabel,
  getTodaySystemDate,
  getYearDateRange,
  isOperationalTemperatureStatus,
  parseDateInput,
  parsePositiveInt,
  periodKey
} from "./utils";

const MODULE_PATH = "/controle-temperatura-equipamentos";
const CARD_CLASS =
  "bpma-card";
const INPUT_CLASS =
  "bpma-input";

const MONTH_OPTIONS = [
  { value: 1, label: "Janeiro" },
  { value: 2, label: "Fevereiro" },
  { value: 3, label: "Março" },
  { value: 4, label: "Abril" },
  { value: 5, label: "Maio" },
  { value: 6, label: "Junho" },
  { value: 7, label: "Julho" },
  { value: 8, label: "Agosto" },
  { value: 9, label: "Setembro" },
  { value: 10, label: "Outubro" },
  { value: 11, label: "Novembro" },
  { value: 12, label: "Dezembro" }
];

type SearchParams = Record<string, string | string[] | undefined>;
type PageProps = { searchParams: Promise<SearchParams> };

export const dynamic = "force-dynamic";

function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function buildPathWithParams(params: URLSearchParams): string {
  const queryString = params.toString();
  return queryString ? `${MODULE_PATH}?${queryString}` : MODULE_PATH;
}

function parseStatusFilter(value: string): StatusTemperaturaEquipamento | null {
  if (value === StatusTemperaturaEquipamento.CONFORME) {
    return StatusTemperaturaEquipamento.CONFORME;
  }

  if (value === StatusTemperaturaEquipamento.ALERTA) {
    return StatusTemperaturaEquipamento.ALERTA;
  }

  if (value === StatusTemperaturaEquipamento.CRITICO) {
    return StatusTemperaturaEquipamento.CRITICO;
  }

  return null;
}

function isOperationalRecord(registro: {
  statusOperacionalEquipamento: StatusOperacionalEquipamento;
}): boolean {
  return isOperationalTemperatureStatus(registro.statusOperacionalEquipamento);
}

function getConfiguredTemperatureShifts(equipment: {
  turnoManha: boolean;
  turnoTarde: boolean;
}): TurnoTemperaturaEquipamento[] {
  return [
    ...(equipment.turnoManha ? [TurnoTemperaturaEquipamento.MANHA] : []),
    ...(equipment.turnoTarde ? [TurnoTemperaturaEquipamento.TARDE] : [])
  ];
}

function getEquipmentShiftKey(
  equipamento: string,
  turno: TurnoTemperaturaEquipamento
): string {
  return `${normalizeOption(equipamento)}:${turno}`;
}

export default async function ControleTemperaturaEquipamentosPage({
  searchParams
}: PageProps) {
  const authUser = await getCurrentUser();
  const responsavelLogado = authUser?.nomeCompleto ?? "Usuário logado";
  const podeGerenciarOpcoes = authUser
    ? hasPermission(authUser, "modulo.temperatura.gerenciar_cadastros")
    : false;
  const podeVerGestao = authUser
    ? hasPermission(authUser, "modulo.temperatura.acessar_historico") || podeGerenciarOpcoes
    : false;
  const podeExcluirRegistros = authUser
    ? hasPermission(authUser, "modulo.temperatura.excluir_registro")
    : false;

  const params = await searchParams;
  const feedback = firstParam(params.feedback).trim();
  const feedbackType = firstParam(params.feedbackType) === "error" ? "error" : "success";

  const now = getCurrentSystemDateTime();
  const todayDateInput = formatDateInput(now);

  const filtroDataRaw = firstParam(params.filtroData).trim();
  const filtroMesRaw = firstParam(params.filtroMes).trim();
  const filtroAnoRaw = firstParam(params.filtroAno).trim();
  const filtroStatusRaw = firstParam(params.filtroStatus).trim();
  const filtroEquipamento = firstParam(params.filtroEquipamento).trim();
  const filtroResponsavel = firstParam(params.filtroResponsavel).trim();
  const hasManualFilters = Boolean(
    filtroDataRaw ||
      filtroMesRaw ||
      filtroAnoRaw ||
      filtroEquipamento ||
      filtroStatusRaw ||
      filtroResponsavel
  );
  const filtroData = hasManualFilters ? filtroDataRaw : todayDateInput;
  const filtroMes = parsePositiveInt(filtroMesRaw);
  const filtroAno = parsePositiveInt(filtroAnoRaw);
  const filtroStatus = parseStatusFilter(filtroStatusRaw);

  const where: Prisma.ControleTemperaturaEquipamentoWhereInput = {};
  const dataFiltro = parseDateInput(filtroData);

  if (dataFiltro) {
    where.data = dataFiltro;
  } else if (filtroMes && filtroAno && filtroMes <= 12) {
    const { start, end } = getMonthDateRange(filtroMes, filtroAno);
    where.data = { gte: start, lte: end };
  } else if (filtroAno) {
    const { start, end } = getYearDateRange(filtroAno);
    where.data = { gte: start, lte: end };
  }

  if (filtroEquipamento) {
    where.equipamento = { contains: filtroEquipamento, mode: "insensitive" };
  }

  if (filtroStatus) {
    where.status = filtroStatus;
    where.statusOperacionalEquipamento = StatusOperacionalEquipamento.EM_OPERACAO;
  }

  if (filtroResponsavel) {
    where.responsavel = { contains: filtroResponsavel, mode: "insensitive" };
  }

  const [registros, options, categoryRules] = await Promise.all([
    prisma.controleTemperaturaEquipamento.findMany({
      where,
      orderBy: [{ data: "desc" }, { createdAt: "desc" }]
    }),
    prisma.controleTemperaturaEquipamentoOpcao.findMany({
      orderBy: [{ tipo: "asc" }, { ativo: "desc" }, { nome: "asc" }]
    }),
    prisma.controleTemperaturaCategoriaRegra.findMany({
      where: { isActive: true },
      include: { categoria: { select: { categoria: true } } },
      orderBy: [{ categoriaId: "asc" }, { ordem: "asc" }]
    })
  ]);

  const equipamentoCatalogOptionsAtivas = options.filter(
    (option) =>
      option.tipo === TipoOpcaoTemperaturaEquipamento.EQUIPAMENTO && option.ativo
  );
  const equipamentoOptionsAtivas = equipamentoCatalogOptionsAtivas.map((option) => option.nome);
  const equipamentosCategoria: Array<{
    nome: string;
    categoria: NonNullable<(typeof options)[number]["categoriaEquipamento"]>;
  }> = [];
  for (const option of options) {
    if (
      option.tipo === TipoOpcaoTemperaturaEquipamento.EQUIPAMENTO &&
      option.categoriaEquipamento
    ) {
      equipamentosCategoria.push({
        nome: option.nome,
        categoria: option.categoriaEquipamento
      });
    }
  }
  const equipamentosTurnos = options
    .filter((option) => option.tipo === TipoOpcaoTemperaturaEquipamento.EQUIPAMENTO)
    .map((option) => ({
      nome: option.nome,
      turnos: getConfiguredTemperatureShifts(option)
    }));
  const regrasCategoriaForm = categoryRules.map((regra) => ({
    categoria: regra.categoria.categoria,
    temperaturaMin: regra.temperaturaMin,
    temperaturaMax: regra.temperaturaMax,
    status: regra.status,
    acaoCorretiva: regra.acaoCorretiva,
    ordem: regra.ordem,
    isActive: regra.isActive
  }));
  const configuracaoDisponivel =
    equipamentoOptionsAtivas.length > 0 && regrasCategoriaForm.length > 0;

  const editId = parsePositiveInt(firstParam(params.editId));
  const deleteId = parsePositiveInt(firstParam(params.deleteId));
  const fotoId = parsePositiveInt(firstParam(params.fotoId));
  const novoRegistroSelecionado = firstParam(params.new) === "1";
  const registroEmEdicao = editId
    ? await prisma.controleTemperaturaEquipamento.findUnique({ where: { id: editId } })
    : null;
  const registroParaExcluir = deleteId
    ? await prisma.controleTemperaturaEquipamento.findUnique({ where: { id: deleteId } })
    : null;
  const fotoRegistroEmEdicao = registroEmEdicao
    ? getStoredImageSrc({
        url: registroEmEdicao.fotoUrl,
        mimeType: registroEmEdicao.fotoMimeType,
        base64: registroEmEdicao.fotoBase64
      })
    : null;

  const fechamentoMesRaw = parsePositiveInt(firstParam(params.fechamentoMes));
  const fechamentoAnoRaw = parsePositiveInt(firstParam(params.fechamentoAno));
  const periodoAtual = getMonthYear(now);
  const fechamentoMes =
    fechamentoMesRaw && fechamentoMesRaw >= 1 && fechamentoMesRaw <= 12
      ? fechamentoMesRaw
      : periodoAtual.mes;
  const fechamentoAno = fechamentoAnoRaw ?? periodoAtual.ano;

  const periodos = new Map<string, { mes: number; ano: number }>();
  for (const registro of registros) {
    const periodo = getMonthYear(registro.data);
    periodos.set(periodKey(periodo.mes, periodo.ano), periodo);
  }
  if (registroEmEdicao) {
    const periodo = getMonthYear(registroEmEdicao.data);
    periodos.set(periodKey(periodo.mes, periodo.ano), periodo);
  }
  if (registroParaExcluir) {
    const periodo = getMonthYear(registroParaExcluir.data);
    periodos.set(periodKey(periodo.mes, periodo.ano), periodo);
  }
  periodos.set(periodKey(fechamentoMes, fechamentoAno), {
    mes: fechamentoMes,
    ano: fechamentoAno
  });

  const periodosAssinados = periodos.size
    ? await prisma.controleTemperaturaEquipamentoFechamento.findMany({
        where: {
          status: StatusFechamentoTemperaturaEquipamento.ASSINADO,
          OR: Array.from(periodos.values()).map((periodo) => ({
            mes: periodo.mes,
            ano: periodo.ano
          }))
        }
      })
    : [];

  const assinadosSet = new Set(
    periodosAssinados.map((item) => periodKey(item.mes, item.ano))
  );
  const periodoEdicao = registroEmEdicao ? getMonthYear(registroEmEdicao.data) : null;
  const registroEmEdicaoBloqueado = periodoEdicao
    ? assinadosSet.has(periodKey(periodoEdicao.mes, periodoEdicao.ano))
    : false;
  const periodoExclusao = registroParaExcluir ? getMonthYear(registroParaExcluir.data) : null;
  const registroParaExcluirBloqueado = periodoExclusao
    ? assinadosSet.has(periodKey(periodoExclusao.mes, periodoExclusao.ano))
    : false;

  const parametrosRetorno = new URLSearchParams();
  if (filtroData) parametrosRetorno.set("filtroData", filtroData);
  if (filtroMes) parametrosRetorno.set("filtroMes", String(filtroMes));
  if (filtroAno) parametrosRetorno.set("filtroAno", String(filtroAno));
  if (filtroEquipamento) parametrosRetorno.set("filtroEquipamento", filtroEquipamento);
  if (filtroStatus) parametrosRetorno.set("filtroStatus", filtroStatus);
  if (filtroResponsavel) parametrosRetorno.set("filtroResponsavel", filtroResponsavel);
  parametrosRetorno.set("fechamentoMes", String(fechamentoMes));
  parametrosRetorno.set("fechamentoAno", String(fechamentoAno));

  const hrefNovoRegistro = (() => {
    const query = new URLSearchParams(parametrosRetorno);
    query.set("new", "1");
    return buildPathWithParams(query);
  })();
  const formReturnTo = (() => {
    const query = new URLSearchParams(parametrosRetorno);
    if (registroEmEdicao) {
      query.set("editId", String(registroEmEdicao.id));
    } else {
      query.set("new", "1");
    }
    return buildPathWithParams(query);
  })();
  const hrefCancelarFormulario = buildPathWithParams(parametrosRetorno);
  const mostrarFormulario = novoRegistroSelecionado || Boolean(registroEmEdicao);
  const modalError = feedback && feedbackType === "error" ? feedback : "";
  const dataFormulario =
    registroEmEdicao?.data ?? parseDateInput(todayDateInput) ?? getTodaySystemDate();
  const turnoFormulario =
    registroEmEdicao?.turno ??
    (getCurrentShift(now) === "MANHA"
      ? TurnoTemperaturaEquipamento.MANHA
      : TurnoTemperaturaEquipamento.TARDE);
  const registrosDuplicidadeFormulario = mostrarFormulario
    ? await prisma.controleTemperaturaEquipamento.findMany({
        where: {
          data: dataFormulario,
          ...(registroEmEdicao ? { id: { not: registroEmEdicao.id } } : {})
        },
        select: {
          id: true,
          equipamento: true,
          turno: true
        },
        orderBy: [{ createdAt: "desc" }]
      })
    : [];
  const turnosRegistradosPorEquipamento = new Set(
    registrosDuplicidadeFormulario.map((registro) =>
      getEquipmentShiftKey(registro.equipamento, registro.turno)
    )
  );
  const equipamentosPendentes = equipamentoCatalogOptionsAtivas
    .map((option) => {
      const turnosPendentes = getConfiguredTemperatureShifts(option).filter(
        (turno) =>
          !turnosRegistradosPorEquipamento.has(
            getEquipmentShiftKey(option.nome, turno)
          )
      );

      return { option, turnosPendentes };
    })
    .filter(({ turnosPendentes }) => turnosPendentes.length > 0);
  const equipamentoOptionsPendentes = equipamentosPendentes.map(
    ({ option }) => option.nome
  );
  const equipamentoFormOptions = registroEmEdicao
    ? !equipamentoOptionsAtivas.includes(registroEmEdicao.equipamento)
      ? [registroEmEdicao.equipamento, ...equipamentoOptionsAtivas]
      : equipamentoOptionsAtivas
    : equipamentoOptionsPendentes;
  const equipamentosTurnosFormulario = registroEmEdicao
    ? equipamentosTurnos
    : equipamentosPendentes.map(({ option, turnosPendentes }) => ({
        nome: option.nome,
        turnos: turnosPendentes
      }));
  const semEquipamentosDisponiveis =
    !registroEmEdicao && equipamentoFormOptions.length === 0;
  const registrosDuplicidadeForm = registrosDuplicidadeFormulario.map((registro) => {
    const query = new URLSearchParams(parametrosRetorno);
    query.set("editId", String(registro.id));

    return {
      id: registro.id,
      equipamento: registro.equipamento,
      turno: registro.turno,
      href: buildPathWithParams(query)
    };
  });
  const deleteReturnTo = (() => {
    const query = new URLSearchParams(parametrosRetorno);
    if (registroParaExcluir) {
      query.set("deleteId", String(registroParaExcluir.id));
    }
    return buildPathWithParams(query);
  })();

  const registroFotoSelecionado = fotoId
    ? registros.find((registro) => registro.id === fotoId) ?? null
    : null;
  const fotoSelecionadaFallbackSrc = registroFotoSelecionado
    ? getImageDataUrl(
        registroFotoSelecionado.fotoMimeType,
        registroFotoSelecionado.fotoBase64
      )
    : null;
  const fotoSelecionadaPrimarySrc =
    registroFotoSelecionado?.fotoUrl?.trim() || fotoSelecionadaFallbackSrc;
  const hrefFecharFoto = buildPathWithParams(parametrosRetorno);
  const buildHrefFoto = (id: number) => {
    const query = new URLSearchParams(parametrosRetorno);
    query.set("fotoId", String(id));
    return buildPathWithParams(query);
  };

  return (
    <div className="space-y-6 dark:text-slate-100">
      <DocumentosModuleHeader
        title="Controle de Temperatura de Equipamentos"
        description="Registro diário de temperatura dos equipamentos"
        modulo={ModuloDocumento.CONTROLE_TEMPERATURA}
        modulePath={MODULE_PATH}
        searchParams={params}
        managementHref={podeGerenciarOpcoes ? "/controle-temperatura-equipamentos/opcoes" : undefined}
        historyHref={podeVerGestao ? "/controle-temperatura-equipamentos/historico" : undefined}
        maintenanceHref="/chamados-manutencao?origem=TEMPERATURA"
      />

      {feedback ? (
        <section
          className={`rounded-xl border p-4 text-sm ${
            feedbackType === "error"
              ? "border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-200"
              : "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
          }`}
        >
          {feedback}
        </section>
      ) : null}

      <div className={registroEmEdicao ? "bpma-modal-backdrop" : ""}>
        <section className={registroEmEdicao ? "bpma-modal-panel max-w-3xl" : CARD_CLASS}>
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
              {registroEmEdicao ? "Editar Registro" : "Cadastro de Registro"}
            </h2>
            {mostrarFormulario ? (
              <Link href={hrefCancelarFormulario} className="btn-secondary">
                Cancelar
              </Link>
            ) : null}
          </div>

          {registroEmEdicao && modalError ? (
            <p className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
              {modalError}
            </p>
          ) : null}

          {!mostrarFormulario ? (
            <p className="text-sm text-slate-600 dark:text-slate-300">
              Clique em <strong>Novo Registro</strong> para abrir o formulário. A ação de edição
              abre em modal sobreposto a partir da lista.
            </p>
          ) : !configuracaoDisponivel ? (
            <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
              O módulo ainda não possui equipamentos ou regras de temperatura suficientes para cadastro.
              {podeGerenciarOpcoes ? (
                <>
                  {" "}
                  Use <strong>Gerenciar Opções</strong> para concluir a configuração inicial.
                </>
              ) : (
                " Solicite à gestão a configuração inicial do módulo."
              )}
            </p>
          ) : semEquipamentosDisponiveis ? (
            <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
              Todos os equipamentos previstos para este período já foram registrados.
            </p>
          ) : registroEmEdicao && registroEmEdicaoBloqueado ? (
            <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
              Este registro pertence a um mês fechado e não pode ser alterado.
            </p>
          ) : (
            <form
              action={registroEmEdicao ? updateRegistroAction : createRegistroAction}
              className="grid gap-4 md:grid-cols-2"
            >
              <input type="hidden" name="returnTo" value={formReturnTo} />
              {registroEmEdicao ? <input type="hidden" name="id" value={registroEmEdicao.id} /> : null}

            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-700 dark:bg-slate-800">
              <p className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Data do Procedimento
              </p>
              <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                {registroEmEdicao
                  ? formatDateDisplay(registroEmEdicao.data)
                  : formatDateTimeDisplay(now)}
              </p>
            </div>

            <AutomaticCorrectiveActionFields
              equipamentoOptions={equipamentoFormOptions}
              equipamentosCategoria={equipamentosCategoria}
              equipamentosTurnos={equipamentosTurnosFormulario}
              regrasCategoria={regrasCategoriaForm}
              registrosDuplicidade={registrosDuplicidadeForm}
              defaultEquipamento={registroEmEdicao?.equipamento ?? ""}
              defaultTurno={turnoFormulario}
              allowTurnoSelection={!registroEmEdicao}
              defaultTemperatura={
                registroEmEdicao?.temperaturaAferida !== null &&
                registroEmEdicao?.temperaturaAferida !== undefined
                  ? String(registroEmEdicao.temperaturaAferida).replace(".", ",")
                  : ""
              }
              defaultAcaoCorretiva={registroEmEdicao?.acaoCorretiva ?? ""}
              defaultStatusOperacional={
                registroEmEdicao?.statusOperacionalEquipamento ??
                StatusOperacionalEquipamento.EM_OPERACAO
              }
              inputClassName={INPUT_CLASS}
            />

            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-700 dark:bg-slate-800">
              <p className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Responsável
              </p>
              <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                {responsavelLogado}
              </p>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Preenchido automaticamente pelo usuário logado.
              </p>
            </div>

            <ImageUploadField
              name="fotoDesvio"
              label="Anexar foto da evidência"
              existingImageDataUrl={fotoRegistroEmEdicao}
              existingFileName={registroEmEdicao?.fotoNome ?? null}
              helperText="Obrigatória em Alerta/Crítico. A imagem será otimizada para até 1280 px e deve ficar com no máximo 1 MB."
              maxBytes={TEMPERATURE_EVIDENCE_IMAGE_MAX_BYTES}
              compressBeforeUpload
              compressionTargetBytes={TEMPERATURE_EVIDENCE_IMAGE_TARGET_BYTES}
              compressionMaxWidth={TEMPERATURE_EVIDENCE_IMAGE_MAX_WIDTH}
              requiredStatusFieldName="statusCalculado"
              requiredStatusValues={["ALERTA", "CRITICO"]}
              requiredMessage="Anexe uma foto da evidência para salvar este registro."
              disabledStatusFieldName="statusOperacionalEquipamento"
              disabledStatusValues={[
                StatusOperacionalEquipamento.MANUTENCAO,
                StatusOperacionalEquipamento.INATIVO
              ]}
              disabledMessage="Foto não é necessária quando o equipamento está em manutenção ou inativo."
              inputClassName={INPUT_CLASS}
            />

            <label className="text-sm text-slate-700 md:col-span-2 dark:text-slate-200">
              Observação, se necessário
              <textarea
                name="observacaoStatusOperacional"
                rows={3}
                defaultValue={
                  registroEmEdicao?.observacaoStatusOperacional ??
                  registroEmEdicao?.observacoes ??
                  ""
                }
                className={INPUT_CLASS}
              />
            </label>

            <div className="md:col-span-2">
              <button type="submit" className="btn-primary">
                {registroEmEdicao ? "Salvar Alterações" : "Salvar Registro"}
              </button>
            </div>
            </form>
          )}
        </section>
      </div>

      <section className={CARD_CLASS}>
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
            Registros do Dia
          </h2>
          {configuracaoDisponivel ? (
            <Link href={hrefNovoRegistro} className="btn-primary">
              Novo Registro
            </Link>
          ) : null}
        </div>

        {podeVerGestao ? (
        <form method="get" className="grid gap-3 rounded-lg bg-slate-50 p-4 md:grid-cols-6 dark:bg-slate-800">
          <input type="hidden" name="fechamentoMes" value={String(fechamentoMes)} />
          <input type="hidden" name="fechamentoAno" value={String(fechamentoAno)} />

          <label className="text-sm text-slate-700 dark:text-slate-200">
            Data
            <input type="date" name="filtroData" defaultValue={filtroData} className={INPUT_CLASS} />
          </label>
          <label className="text-sm text-slate-700 dark:text-slate-200">
            Mês
            <select name="filtroMes" defaultValue={filtroMes ? String(filtroMes) : ""} className={INPUT_CLASS}>
              <option value="">Todos</option>
              {MONTH_OPTIONS.map((month) => (
                <option key={month.value} value={String(month.value)}>
                  {month.label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm text-slate-700 dark:text-slate-200">
            Ano
            <input
              type="number"
              name="filtroAno"
              min={2020}
              max={2100}
              defaultValue={filtroAno ?? ""}
              className={INPUT_CLASS}
            />
          </label>
          <label className="text-sm text-slate-700 dark:text-slate-200">
            Equipamento
            <input
              type="text"
              name="filtroEquipamento"
              defaultValue={filtroEquipamento}
              className={INPUT_CLASS}
            />
          </label>
          <label className="text-sm text-slate-700 dark:text-slate-200">
            Status
            <select
              name="filtroStatus"
              defaultValue={filtroStatus ?? ""}
              className={INPUT_CLASS}
            >
              <option value="">Todos</option>
              <option value={StatusTemperaturaEquipamento.CONFORME}>Normal</option>
              <option value={StatusTemperaturaEquipamento.ALERTA}>Alerta</option>
              <option value={StatusTemperaturaEquipamento.CRITICO}>Crítico</option>
            </select>
          </label>
          <label className="text-sm text-slate-700 dark:text-slate-200">
            Responsável
            <input
              type="text"
              name="filtroResponsavel"
              defaultValue={filtroResponsavel}
              className={INPUT_CLASS}
            />
          </label>

          <div className="btn-group md:col-span-6">
            <button type="submit" className="btn-primary">
              Aplicar Filtros
            </button>
            <Link
              href={buildPathWithParams(
                new URLSearchParams({
                  fechamentoMes: String(fechamentoMes),
                  fechamentoAno: String(fechamentoAno)
                })
              )}
              className="btn-secondary"
            >
              Limpar
            </Link>
          </div>
        </form>
        ) : (
          <p className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">
            Exibindo os registros de temperatura de hoje.
          </p>
        )}

        <p className="mt-4 text-sm text-slate-600 dark:text-slate-300">
          A listagem principal mostra os registros da data atual automaticamente.
          {podeVerGestao ? (
            <>
              {" "}
              Use os filtros ou o <strong>Histórico</strong> para outras consultas.
            </>
          ) : null}
        </p>

        <div className="mt-4 overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-sm dark:divide-slate-700">
            <thead className="bg-slate-50 text-left text-slate-700 dark:bg-slate-800 dark:text-slate-200">
              <tr>
                <th className="px-3 py-2">Data</th>
                <th className="px-3 py-2">Equipamento</th>
                <th className="px-3 py-2">Turno</th>
                <th className="px-3 py-2">Status operacional</th>
                <th className="px-3 py-2">Temperatura</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2 min-w-52">Ação Corretiva</th>
                <th className="px-3 py-2">Foto</th>
                <th className="px-3 py-2 min-w-44">Observação</th>
                <th className="px-3 py-2">Responsável</th>
                <th className="px-3 py-2">Ações</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {registros.length === 0 ? (
                <tr>
                  <td className="px-3 py-3 text-slate-500 dark:text-slate-400" colSpan={11}>
                    Nenhum registro encontrado.
                  </td>
                </tr>
              ) : (
                registros.map((registro) => {
                  const periodo = getMonthYear(registro.data);
                  const bloqueado =
                    assinadosSet.has(periodKey(periodo.mes, periodo.ano)) ||
                    formatDateInput(registro.data) !== todayDateInput;
                  const hrefEditar = (() => {
                    const query = new URLSearchParams(parametrosRetorno);
                    query.set("editId", String(registro.id));
                    return buildPathWithParams(query);
                  })();
                  const hasStoredImage = hasImageEvidence({
                    url: registro.fotoUrl,
                    mimeType: registro.fotoMimeType,
                    base64: registro.fotoBase64
                  });
                  const registroEmOperacao = isOperationalRecord(registro);
                  const observacaoRegistro = registroEmOperacao
                    ? registro.observacoes
                    : registro.observacaoStatusOperacional;
                  return (
                    <tr key={registro.id}>
                      <td className="px-3 py-2">{formatDateDisplay(registro.data)}</td>
                      <td className="px-3 py-2">{registro.equipamento}</td>
                      <td className="px-3 py-2">{getShiftLabel(registro.turno)}</td>
                      <td className="px-3 py-2">
                        {getOperationalStatusLabel(registro.statusOperacionalEquipamento)}
                      </td>
                      <td className="px-3 py-2">{formatTemperatureDisplay(registro.temperaturaAferida)}</td>
                      <td className="px-3 py-2">
                        {registroEmOperacao ? (
                          <TemperatureStatusBadge status={registro.status} />
                        ) : (
                          <span className="inline-flex rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200">
                            Não aplicável
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 max-w-64 whitespace-normal break-words">
                        {registroEmOperacao ? registro.acaoCorretiva ?? "-" : "-"}
                      </td>
                      <td className="px-3 py-2">
                        {registroEmOperacao && hasStoredImage ? (
                          <Link
                            href={buildHrefFoto(registro.id)}
                            scroll={false}
                            className="text-sm font-medium text-slate-700 underline-offset-4 hover:underline dark:text-slate-200"
                          >
                            Ver foto
                          </Link>
                        ) : (
                          "-"
                        )}
                      </td>
                      <td className="px-3 py-2 max-w-64 whitespace-normal break-words">
                        {observacaoRegistro?.trim() || "-"}
                      </td>
                      <td className="px-3 py-2">{registro.responsavel}</td>
                      <td className="px-3 py-2">
                        <div className="btn-group">
                          {bloqueado ? (
                            <button type="button" disabled className="btn-action">
                              Editar
                            </button>
                          ) : (
                            <Link href={hrefEditar} className="btn-action">
                              Editar
                            </Link>
                          )}
                          {podeExcluirRegistros ? (
                            bloqueado ? (
                              <button type="button" disabled className="btn-danger">
                                Excluir
                              </button>
                            ) : (
                              <Link
                                href={(() => {
                                  const query = new URLSearchParams(parametrosRetorno);
                                  query.set("deleteId", String(registro.id));
                                  return buildPathWithParams(query);
                                })()}
                                className="btn-danger"
                              >
                                Excluir
                              </Link>
                            )
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      {registroParaExcluir ? (
        <ActionModal
          title="Excluir Registro"
          cancelHref={hrefCancelarFormulario}
          description={
            <p>
              Equipamento: <strong>{registroParaExcluir.equipamento}</strong> em{" "}
              {formatDateDisplay(registroParaExcluir.data)}.
            </p>
          }
        >
          {modalError ? (
            <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
              {modalError}
            </p>
          ) : null}
          {registroParaExcluirBloqueado ? (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
              Este registro pertence a um mês fechado e não pode ser excluído.
            </p>
          ) : (
            <form action={deleteRegistroAction}>
              <input type="hidden" name="id" value={registroParaExcluir.id} />
              <input type="hidden" name="returnTo" value={deleteReturnTo} />
              <p className="text-sm text-slate-600 dark:text-slate-300">
                Confirme a exclusão deste registro. A permissão também será validada no servidor.
              </p>
              <ModalActions>
                <Link href={hrefCancelarFormulario} className="btn-secondary text-center">
                  Cancelar
                </Link>
                <button type="submit" className="btn-danger">
                  Excluir Registro
                </button>
              </ModalActions>
            </form>
          )}
        </ActionModal>
      ) : null}

      {fotoId ? (
        <ActionModal
          title="Foto da evidência"
          cancelHref={hrefFecharFoto}
          maxWidthClassName="max-w-4xl"
          description={
            registroFotoSelecionado ? (
              <p>
                {registroFotoSelecionado.equipamento} em{" "}
                {formatDateDisplay(registroFotoSelecionado.data)}.
              </p>
            ) : null
          }
        >
          {fotoSelecionadaPrimarySrc ? (
            <EvidencePhoto
              primarySrc={fotoSelecionadaPrimarySrc}
              fallbackSrc={fotoSelecionadaFallbackSrc}
              alt={`Foto do registro ${registroFotoSelecionado?.id ?? fotoId}`}
              className="max-h-[75vh] w-full rounded-lg border border-slate-200 object-contain dark:border-slate-700"
            />
          ) : (
            <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
              Foto indisponível.
            </p>
          )}
        </ActionModal>
      ) : null}
    </div>
  );
}
