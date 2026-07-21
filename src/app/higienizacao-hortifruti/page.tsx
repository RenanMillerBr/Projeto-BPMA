import {
  ModuloDocumento,
  Prisma,
  StatusFechamentoHortifruti,
  TipoOpcaoHigienizacao
} from "@prisma/client";
import Link from "next/link";

import { DocumentosModuleHeader } from "@/components/documentos/documentos-module-header";
import { ActionModal, ModalActions } from "@/components/ui/action-modal";
import { getCurrentUser } from "@/lib/auth-session";
import { prisma } from "@/lib/prisma";
import {
  canDeleteOperationalRecords,
  canManageModuleOptions,
  canViewManagementSections
} from "@/lib/rbac";

import {
  createRegistroAction,
  deleteRegistroAction,
  updateRegistroAction
} from "./actions";
import { SearchableOptionField } from "./searchable-option-field";
import {
  formatDateDisplay,
  formatDateInput,
  getMonthDateRange,
  getMonthYear,
  getTodaySystemDate,
  getYearDateRange,
  parseDateInput,
  parsePositiveInt,
  periodKey
} from "./utils";

const MODULE_PATH = "/higienizacao-hortifruti";
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

export default async function HigienizacaoHortifrutiPage({
  searchParams
}: PageProps) {
  const authUser = await getCurrentUser();
  const responsavelLogado = authUser?.nomeCompleto ?? "Usuário logado";
  const isColaborador = authUser?.perfil === "COLABORADOR";
  const podeVerGestao = authUser ? canViewManagementSections(authUser) : false;
  const podeGerenciarOpcoes = authUser ? canManageModuleOptions(authUser) : false;
  const podeExcluirRegistros = authUser ? canDeleteOperationalRecords(authUser) : false;

  const params = await searchParams;
  const feedback = firstParam(params.feedback).trim();
  const feedbackType = firstParam(params.feedbackType) === "error" ? "error" : "success";

  const todayInput = formatDateInput(getTodaySystemDate());
  const filtroData = firstParam(params.filtroData).trim() || (isColaborador ? todayInput : "");
  const filtroMes = parsePositiveInt(firstParam(params.filtroMes));
  const filtroAno = parsePositiveInt(firstParam(params.filtroAno));
  const filtroHortifruti = firstParam(params.filtroHortifruti).trim();
  const filtroResponsavel = firstParam(params.filtroResponsavel).trim();

  const where: Prisma.HigienizacaoHortifrutiWhereInput = {};
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

  if (filtroHortifruti) {
    where.hortifruti = { contains: filtroHortifruti, mode: "insensitive" };
  }

  if (filtroResponsavel) {
    where.responsavel = { contains: filtroResponsavel, mode: "insensitive" };
  }

  const [registros, options] = await Promise.all([
    prisma.higienizacaoHortifruti.findMany({
      where,
      orderBy: [{ data: "desc" }, { inicioProcesso: "asc" }]
    }),
    prisma.higienizacaoHortifrutiOpcao.findMany({
      orderBy: [{ tipo: "asc" }, { nome: "asc" }]
    })
  ]);

  const hortifrutiOptions = options
    .filter((option) => option.tipo === TipoOpcaoHigienizacao.HORTIFRUTI)
    .map((option) => option.nome);
  const produtoUtilizadoOptions = options
    .filter((option) => option.tipo === TipoOpcaoHigienizacao.PRODUTO_UTILIZADO)
    .map((option) => option.nome);
  const catalogoDisponivel =
    hortifrutiOptions.length > 0 && produtoUtilizadoOptions.length > 0;

  const editId = parsePositiveInt(firstParam(params.editId));
  const deleteId = parsePositiveInt(firstParam(params.deleteId));
  const novoRegistroSelecionado = firstParam(params.new) === "1";
  const registroEmEdicao = editId
    ? await prisma.higienizacaoHortifruti.findUnique({ where: { id: editId } })
    : null;
  const registroParaExcluir = deleteId
    ? await prisma.higienizacaoHortifruti.findUnique({ where: { id: deleteId } })
    : null;

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
  const periodosAssinados = periodos.size
    ? await prisma.higienizacaoHortifrutiFechamento.findMany({
        where: {
          status: StatusFechamentoHortifruti.ASSINADO,
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
  const registroEmEdicaoBloqueadoPorPerfil = Boolean(registroEmEdicao && isColaborador);
  const periodoExclusao = registroParaExcluir ? getMonthYear(registroParaExcluir.data) : null;
  const registroParaExcluirBloqueado = periodoExclusao
    ? assinadosSet.has(periodKey(periodoExclusao.mes, periodoExclusao.ano))
    : false;

  const parametrosRetorno = new URLSearchParams();
  if (filtroData) parametrosRetorno.set("filtroData", filtroData);
  if (filtroMes) parametrosRetorno.set("filtroMes", String(filtroMes));
  if (filtroAno) parametrosRetorno.set("filtroAno", String(filtroAno));
  if (filtroHortifruti) parametrosRetorno.set("filtroHortifruti", filtroHortifruti);
  if (filtroResponsavel) parametrosRetorno.set("filtroResponsavel", filtroResponsavel);

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
  const deleteReturnTo = (() => {
    const query = new URLSearchParams(parametrosRetorno);
    if (registroParaExcluir) {
      query.set("deleteId", String(registroParaExcluir.id));
    }
    return buildPathWithParams(query);
  })();

  return (
    <div className="space-y-6 dark:text-slate-100">
      <DocumentosModuleHeader
        title="Higienização de Hortifruti"
        description="Registro diário de higienização"
        modulo={ModuloDocumento.HIGIENIZACAO_HORTIFRUTI}
        modulePath={MODULE_PATH}
        searchParams={params}
        managementHref={podeGerenciarOpcoes ? "/higienizacao-hortifruti/opcoes" : undefined}
        maintenanceHref="/chamados-manutencao?origem=HORTIFRUTI"
        actions={
          <>
            {podeVerGestao ? (
              <Link href="/higienizacao-hortifruti/historico" className="btn-secondary">
                Histórico
              </Link>
            ) : null}
          </>
        }
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
          ) : !catalogoDisponivel ? (
            <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
              Nenhuma opção de hortifruti ou produto foi cadastrada ainda.
              {podeGerenciarOpcoes ? (
                <>
                  {" "}
                  Use <strong>Gerenciar Opções</strong> para iniciar o módulo.
                </>
              ) : (
                " Solicite à gestão a configuração inicial do módulo."
              )}
            </p>
          ) : registroEmEdicao && registroEmEdicaoBloqueado ? (
            <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
              Este registro pertence a um mês fechado e não pode ser alterado.
            </p>
          ) : registroEmEdicao && registroEmEdicaoBloqueadoPorPerfil ? (
            <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
              Você não possui permissão para editar este registro.
            </p>
          ) : (
            <form action={registroEmEdicao ? updateRegistroAction : createRegistroAction} className="grid gap-4 md:grid-cols-2">
              <input type="hidden" name="returnTo" value={formReturnTo} />
              {registroEmEdicao ? <input type="hidden" name="id" value={registroEmEdicao.id} /> : null}

            {registroEmEdicao ? (
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 md:col-span-2 dark:border-slate-700 dark:bg-slate-800">
                <p className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">Data do Procedimento</p>
                <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                  {formatDateDisplay(registroEmEdicao.data)}
                </p>
              </div>
            ) : (
              <label className="text-sm text-slate-700 md:col-span-2 dark:text-slate-200">
                Data do Procedimento *
                <input
                  type="date"
                  name="data"
                  required
                  defaultValue={todayInput}
                  className={INPUT_CLASS}
                />
              </label>
            )}

            <label className="text-sm text-slate-700 dark:text-slate-200">
              Hortifruti *
              <SearchableOptionField name="hortifruti" options={hortifrutiOptions} defaultValue={registroEmEdicao?.hortifruti ?? ""} placeholder="Digite para buscar..." />
            </label>
            <label className="text-sm text-slate-700 dark:text-slate-200">
              Produto Utilizado *
              <SearchableOptionField name="produtoUtilizado" options={produtoUtilizadoOptions} defaultValue={registroEmEdicao?.produtoUtilizado ?? ""} placeholder="Digite para buscar..." />
            </label>
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
            <label className="text-sm text-slate-700 dark:text-slate-200">
              Início do Processo *
              <input type="time" name="inicioProcesso" required defaultValue={registroEmEdicao?.inicioProcesso ?? ""} className={INPUT_CLASS} />
            </label>
            <label className="text-sm text-slate-700 dark:text-slate-200">
              Término do Processo *
              <input type="time" name="terminoProcesso" required defaultValue={registroEmEdicao?.terminoProcesso ?? ""} className={INPUT_CLASS} />
            </label>
            <label className="text-sm text-slate-700 md:col-span-2 dark:text-slate-200">
              Observações (Opcional)
              <textarea name="observacoes" rows={3} defaultValue={registroEmEdicao?.observacoes ?? ""} className={INPUT_CLASS} />
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
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">Registros</h2>
          {catalogoDisponivel ? (
            <Link href={hrefNovoRegistro} className="btn-primary">Novo Registro</Link>
          ) : null}
        </div>
        {podeVerGestao ? (
          <form method="get" className="grid gap-3 rounded-lg bg-slate-50 p-4 md:grid-cols-5 dark:bg-slate-800">
            <label className="text-sm text-slate-700 dark:text-slate-200">Data<input type="date" name="filtroData" defaultValue={filtroData} className={INPUT_CLASS} /></label>
            <label className="text-sm text-slate-700 dark:text-slate-200">Mês<select name="filtroMes" defaultValue={filtroMes ? String(filtroMes) : ""} className={INPUT_CLASS}><option value="">Todos</option>{MONTH_OPTIONS.map((month) => <option key={month.value} value={String(month.value)}>{month.label}</option>)}</select></label>
            <label className="text-sm text-slate-700 dark:text-slate-200">Ano<input type="number" name="filtroAno" min={2020} max={2100} defaultValue={filtroAno ?? ""} className={INPUT_CLASS} /></label>
            <label className="text-sm text-slate-700 dark:text-slate-200">Hortifruti<input type="text" name="filtroHortifruti" defaultValue={filtroHortifruti} className={INPUT_CLASS} /></label>
            <label className="text-sm text-slate-700 dark:text-slate-200">Responsável<input type="text" name="filtroResponsavel" defaultValue={filtroResponsavel} className={INPUT_CLASS} /></label>
            <div className="btn-group md:col-span-5">
              <button type="submit" className="btn-primary">Aplicar Filtros</button>
              <Link href={MODULE_PATH} className="btn-secondary">Limpar</Link>
            </div>
          </form>
        ) : (
          <p className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">
            Exibindo apenas os registros operacionais de hoje.
          </p>
        )}

        <div className="mt-4 overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-sm dark:divide-slate-700">
            <thead className="bg-slate-50 text-left text-slate-700 dark:bg-slate-800 dark:text-slate-200">
              <tr>
                <th className="px-3 py-2">Data</th>
                <th className="px-3 py-2">Hortifruti</th>
                <th className="px-3 py-2">Produto Utilizado</th>
                <th className="px-3 py-2">Início</th>
                <th className="px-3 py-2">Término</th>
                <th className="px-3 py-2">Duração</th>
                <th className="px-3 py-2">Responsável</th>
                <th className="px-3 py-2">Ações</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {registros.length === 0 ? (
                <tr>
                  <td className="px-3 py-3 text-slate-500 dark:text-slate-400" colSpan={8}>
                    Nenhum registro encontrado.
                  </td>
                </tr>
              ) : (
                registros.map((registro) => {
                  const periodo = getMonthYear(registro.data);
                  const bloqueado = assinadosSet.has(periodKey(periodo.mes, periodo.ano));
                  const hrefEditar = (() => {
                    const query = new URLSearchParams(parametrosRetorno);
                    query.set("editId", String(registro.id));
                    return buildPathWithParams(query);
                  })();

                  return (
                    <tr key={registro.id}>
                      <td className="px-3 py-2">{formatDateDisplay(registro.data)}</td>
                      <td className="px-3 py-2">{registro.hortifruti}</td>
                      <td className="px-3 py-2">{registro.produtoUtilizado}</td>
                      <td className="px-3 py-2">{registro.inicioProcesso}</td>
                      <td className="px-3 py-2">{registro.terminoProcesso}</td>
                      <td className="px-3 py-2">{registro.duracaoMinutos} min</td>
                      <td className="px-3 py-2">{registro.responsavel}</td>
                      <td className="px-3 py-2">
                        <div className="btn-group">
                          {!isColaborador ? (
                            <Link href={hrefEditar} className="btn-action">
                              Editar
                            </Link>
                          ) : null}
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
              Hortifruti: <strong>{registroParaExcluir.hortifruti}</strong> em{" "}
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
                Confirme a exclusão deste registro. A validação de permissão também será feita no servidor.
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
    </div>
  );
}
