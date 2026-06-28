"use server";

import {
  StatusFechamentoTemperaturaEquipamento,
  StatusOperacionalEquipamento,
  StatusTemperaturaEquipamento,
  TipoOpcaoTemperaturaEquipamento,
  TurnoTemperaturaEquipamento
} from "@prisma/client";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { rethrowIfRedirectError } from "@/lib/redirect-error";

import { getCurrentUserForAction } from "@/lib/auth-session";
import {
  createSignatureLog,
  ensurePermission,
  validateSignaturePassword
} from "@/lib/authz";
import { canEditRecordDate } from "@/lib/permissions";
import {
  hasStoredImage,
  parseImageUploadFromFormData
} from "@/lib/image-upload";
import { TEMPERATURE_EVIDENCE_IMAGE_MAX_BYTES } from "@/lib/image-upload-rules";
import { saveTemperatureEquipmentEvidenceImage } from "@/lib/local-image-storage";
import { prisma } from "@/lib/prisma";

import {
  findCatalogOptionByName,
  getCategoryParameterByCategory,
  hasCatalogOptionWithSameName,
  parseEquipmentCategory,
  parseOptionType,
  sanitizeCatalogName
} from "./catalog";
import {
  findMatchingTemperatureRule,
  getAutomaticCorrectiveAction,
  getCurrentShift,
  getCurrentSystemDateTime,
  getMonthDateRange,
  getMonthYear,
  getTodaySystemDate,
  isCorrectiveActionRequired,
  parseNullableTemperatureInput,
  parsePositiveInt,
  parseTemperatureInput
} from "./utils";

const MODULE_PATH = "/controle-temperatura-equipamentos";
const HISTORY_PATH = "/controle-temperatura-equipamentos/historico";
const OPTIONS_PATH = "/controle-temperatura-equipamentos/opcoes";
const DUPLICATE_MEASUREMENT_MESSAGE =
  "Este equipamento já possui registro para este dia/turno.";

type FeedbackType = "success" | "error";

function getInputValue(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function getInputValues(formData: FormData, key: string): string[] {
  return formData
    .getAll(key)
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);
}

function getReturnToPath(formData: FormData): string {
  const value = getInputValue(formData, "returnTo");

  if (!value.startsWith(MODULE_PATH)) {
    return MODULE_PATH;
  }

  return value;
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    const technicalPattern =
      /next_redirect|invalid `prisma|prismaclient|typeerror|referenceerror|syntaxerror|p20\d{2}|stack/i;
    if (technicalPattern.test(error.message)) {
      return fallback;
    }
    return error.message;
  }

  return fallback;
}

function redirectWithFeedback(
  returnTo: string,
  feedbackType: FeedbackType,
  feedback: string
): never {
  const url = new URL(returnTo, "http://localhost");
  if (feedbackType === "success") {
    url.searchParams.delete("new");
    url.searchParams.delete("editId");
    url.searchParams.delete("editEquipamentoId");
    url.searchParams.delete("editAcaoId");
    url.searchParams.delete("editCategoriaId");
    url.searchParams.delete("editRegraId");
    url.searchParams.delete("novaRegraCategoriaId");
    url.searchParams.delete("deleteId");
  }
  url.searchParams.set("feedbackType", feedbackType);
  url.searchParams.set("feedback", feedback);

  redirect(`${url.pathname}?${url.searchParams.toString()}`);
}

function revalidateModulePaths() {
  revalidatePath(MODULE_PATH);
  revalidatePath(HISTORY_PATH);
  revalidatePath(OPTIONS_PATH);
}

async function ensureUniqueTemperatureMeasurement(params: {
  equipamento: string;
  data: Date;
  turno: TurnoTemperaturaEquipamento;
  ignoreId?: number;
}) {
  const existing = await prisma.controleTemperaturaEquipamento.findFirst({
    where: {
      equipamento: params.equipamento,
      data: params.data,
      turno: params.turno,
      ...(params.ignoreId ? { id: { not: params.ignoreId } } : {})
    },
    select: { id: true }
  });

  if (existing) {
    throw new Error(DUPLICATE_MEASUREMENT_MESSAGE);
  }
}

function parseShiftValue(value: string): TurnoTemperaturaEquipamento | null {
  if (value === TurnoTemperaturaEquipamento.MANHA) {
    return TurnoTemperaturaEquipamento.MANHA;
  }

  if (value === TurnoTemperaturaEquipamento.TARDE) {
    return TurnoTemperaturaEquipamento.TARDE;
  }

  return null;
}

function getShiftLabel(turno: TurnoTemperaturaEquipamento): string {
  return turno === TurnoTemperaturaEquipamento.MANHA ? "Manhã" : "Tarde";
}

function getConfiguredEquipmentShifts(equipment: {
  turnoManha: boolean;
  turnoTarde: boolean;
}): TurnoTemperaturaEquipamento[] {
  const shifts: TurnoTemperaturaEquipamento[] = [];

  if (equipment.turnoManha) {
    shifts.push(TurnoTemperaturaEquipamento.MANHA);
  }

  if (equipment.turnoTarde) {
    shifts.push(TurnoTemperaturaEquipamento.TARDE);
  }

  return shifts;
}

function parseConfiguredShiftsFromFormData(formData: FormData): {
  turnoManha: boolean;
  turnoTarde: boolean;
} {
  const selectedShifts = new Set(getInputValues(formData, "turnosConferencia"));
  const turnoManha = selectedShifts.has(TurnoTemperaturaEquipamento.MANHA);
  const turnoTarde = selectedShifts.has(TurnoTemperaturaEquipamento.TARDE);

  if (!turnoManha && !turnoTarde) {
    throw new Error("Selecione pelo menos um turno de conferência.");
  }

  return { turnoManha, turnoTarde };
}

function ensureEquipmentSupportsShift(
  configuredShifts: TurnoTemperaturaEquipamento[],
  turno: TurnoTemperaturaEquipamento
) {
  if (!configuredShifts.includes(turno)) {
    throw new Error(
      `Este equipamento não está configurado para conferência no turno ${getShiftLabel(turno)}.`
    );
  }
}

async function isMonthSigned(mes: number, ano: number): Promise<boolean> {
  const fechamento = await prisma.controleTemperaturaEquipamentoFechamento.findUnique({
    where: { mes_ano: { mes, ano } }
  });

  return fechamento?.status === StatusFechamentoTemperaturaEquipamento.ASSINADO;
}

async function getRegistroPayload(formData: FormData, responsavelLogado: string) {
  const equipamentoInput = getInputValue(formData, "equipamento");
  const temperaturaAferidaInput = getInputValue(formData, "temperaturaAferida");
  const observacaoInput =
    getInputValue(formData, "observacaoStatusOperacional") ||
    getInputValue(formData, "observacoes");
  const statusOperacionalEquipamento = parseOperationalStatusValue(
    getInputValue(formData, "statusOperacionalEquipamento")
  );

  if (!equipamentoInput) {
    throw new Error("Preencha todos os campos obrigatórios do registro.");
  }

  if (!responsavelLogado.trim()) {
    throw new Error("Não foi possível identificar o usuário logado para o campo Responsável.");
  }

  const equipamentoOption = await findCatalogOptionByName(
    TipoOpcaoTemperaturaEquipamento.EQUIPAMENTO,
    equipamentoInput,
    true
  );
  if (!equipamentoOption) {
    throw new Error("O equipamento selecionado não existe ou está inativo.");
  }

  if (!equipamentoOption.categoriaEquipamento) {
    throw new Error("O equipamento selecionado está sem categoria configurada.");
  }

  const turnosConferencia = getConfiguredEquipmentShifts(equipamentoOption);
  if (turnosConferencia.length === 0) {
    throw new Error("O equipamento selecionado está sem turnos de conferência configurados.");
  }

  if (statusOperacionalEquipamento !== StatusOperacionalEquipamento.EM_OPERACAO) {
    return {
      equipamento: equipamentoOption.nome,
      categoriaEquipamento: equipamentoOption.categoriaEquipamento,
      turnosConferencia,
      statusOperacionalEquipamento,
      temperaturaAferida: null,
      status: StatusTemperaturaEquipamento.CONFORME,
      acaoCorretiva: null,
      responsavel: responsavelLogado.trim(),
      observacoes: null,
      observacaoStatusOperacional: observacaoInput || null
    };
  }

  if (!temperaturaAferidaInput) {
    throw new Error("Informe a temperatura aferida do equipamento em operação.");
  }

  const temperaturaAferida = parseTemperatureInput(temperaturaAferidaInput);
  if (temperaturaAferida === null) {
    throw new Error("Informe uma temperatura válida.");
  }

  const categoriaParametro = await getCategoryParameterByCategory(
    equipamentoOption.categoriaEquipamento,
    false
  );

  if (!categoriaParametro) {
    throw new Error(
      "A categoria deste equipamento está sem parâmetros configurados. Atualize em Gerenciar Opções."
    );
  }

  const regrasAtivas = await prisma.controleTemperaturaCategoriaRegra.findMany({
    where: {
      categoriaId: categoriaParametro.id,
      isActive: true
    },
    orderBy: [{ ordem: "asc" }, { id: "asc" }]
  });

  if (regrasAtivas.length === 0) {
    throw new Error(
      "A categoria deste equipamento está sem regras de temperatura ativas. Atualize em Gerenciar Opções."
    );
  }

  const regraCorrespondente = findMatchingTemperatureRule(
    temperaturaAferida,
    regrasAtivas
  );

  if (!regraCorrespondente) {
    throw new Error(
      "Não existe regra de temperatura correspondente para esta categoria. Ajuste as regras em Gerenciar Opções."
    );
  }

  const status = regraCorrespondente.status;
  const acaoCorretiva =
    regraCorrespondente.acaoCorretiva.trim() ||
    getAutomaticCorrectiveAction(status, categoriaParametro);

  if (isCorrectiveActionRequired(status) && !acaoCorretiva) {
    throw new Error(
      "A Ação Corretiva é obrigatória quando a temperatura estiver em Alerta ou Crítico."
    );
  }

  return {
    equipamento: equipamentoOption.nome,
    categoriaEquipamento: equipamentoOption.categoriaEquipamento,
    turnosConferencia,
    statusOperacionalEquipamento,
    temperaturaAferida,
    status,
    acaoCorretiva,
    responsavel: responsavelLogado.trim(),
    observacoes: observacaoInput || null,
    observacaoStatusOperacional: null
  };
}

function parseTemperatureField(formData: FormData, key: string): number | null {
  const parsed = parseNullableTemperatureInput(getInputValue(formData, key));

  if (parsed === "invalid") {
    throw new Error("Informe valores de temperatura válidos para os parâmetros.");
  }

  return parsed;
}

function validateRangeBounds(
  min: number | null,
  max: number | null,
  label: string
) {
  if (min !== null && max !== null && min > max) {
    throw new Error(
      `A faixa de ${label} está inválida. O valor mínimo não pode ser maior que o máximo.`
    );
  }
}

function parseStatusValue(value: string): StatusTemperaturaEquipamento | null {
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

function parseOperationalStatusValue(value: string): StatusOperacionalEquipamento {
  if (value === StatusOperacionalEquipamento.MANUTENCAO) {
    return StatusOperacionalEquipamento.MANUTENCAO;
  }

  if (value === StatusOperacionalEquipamento.INATIVO) {
    return StatusOperacionalEquipamento.INATIVO;
  }

  return StatusOperacionalEquipamento.EM_OPERACAO;
}

async function validateRuleOrderAvailability(
  categoriaId: number,
  ordem: number,
  ignoreRuleId?: number
) {
  const existingRule = await prisma.controleTemperaturaCategoriaRegra.findFirst({
    where: {
      categoriaId,
      ordem,
      ...(ignoreRuleId ? { id: { not: ignoreRuleId } } : {})
    }
  });

  if (existingRule) {
    throw new Error("Já existe uma regra com esta ordem para a categoria.");
  }
}

async function ensureCategoryHasAnotherActiveRule(
  categoriaId: number,
  ignoreRuleId: number
) {
  const remainingActiveRules = await prisma.controleTemperaturaCategoriaRegra.count({
    where: {
      categoriaId,
      isActive: true,
      id: { not: ignoreRuleId }
    }
  });

  if (remainingActiveRules === 0) {
    throw new Error("Mantenha ao menos uma regra ativa por categoria.");
  }
}

export async function createRegistroAction(formData: FormData) {
  const returnTo = getReturnToPath(formData);

  try {
    const actor = await getCurrentUserForAction();
    ensurePermission(
      actor,
      "modulo.temperatura.criar_registro",
      "Seu perfil não pode criar registros de temperatura."
    );

    const data = getTodaySystemDate();
    const registroPayload = await getRegistroPayload(formData, actor.nomeCompleto);
    const { turnosConferencia, ...payload } = registroPayload;
    const { mes, ano } = getMonthYear(data);

    if (await isMonthSigned(mes, ano)) {
      throw new Error(
        `O mês ${String(mes).padStart(2, "0")}/${ano} já está fechado e não aceita novos registros.`
      );
    }

    const turnoInput = getInputValue(formData, "turno");
    const turno =
      turnoInput.length > 0
        ? parseShiftValue(turnoInput)
        : getCurrentShift() === "MANHA"
        ? TurnoTemperaturaEquipamento.MANHA
        : TurnoTemperaturaEquipamento.TARDE;

    if (!turno) {
      throw new Error("Selecione um turno de conferência válido.");
    }

    ensureEquipmentSupportsShift(turnosConferencia, turno);

    await ensureUniqueTemperatureMeasurement({
      equipamento: payload.equipamento,
      data,
      turno
    });

    const fotoDesvio =
      payload.statusOperacionalEquipamento === StatusOperacionalEquipamento.EM_OPERACAO
        ? await parseImageUploadFromFormData({
            formData,
            key: "fotoDesvio",
            maxBytes: TEMPERATURE_EVIDENCE_IMAGE_MAX_BYTES,
            required: isCorrectiveActionRequired(payload.status),
            requiredMessage:
              "Anexe uma foto da evidência para salvar este registro."
          })
        : null;
    const fotoArmazenada = fotoDesvio
      ? await saveTemperatureEquipmentEvidenceImage(fotoDesvio)
      : null;

    await prisma.controleTemperaturaEquipamento.create({
      data: {
        ...payload,
        data,
        turno,
        fotoNome: fotoDesvio?.fileName ?? null,
        fotoMimeType: fotoArmazenada?.mimeType ?? null,
        fotoBase64: null,
        fotoUrl: fotoArmazenada?.url ?? null,
        fotoTamanhoBytes: fotoArmazenada?.size ?? null,
        fotoCriadoEm: fotoArmazenada?.createdAt ?? null,
        fotoCriadoPorUsuarioId: fotoArmazenada ? actor.id : null
      }
    });

    revalidateModulePaths();
    redirectWithFeedback(returnTo, "success", "Registro Criado com Sucesso.");
  } catch (error) {
    rethrowIfRedirectError(error);
    redirectWithFeedback(
      returnTo,
      "error",
      getErrorMessage(error, "Não foi possível salvar o registro. Verifique os campos obrigatórios.")
    );
  }
}

export async function updateRegistroAction(formData: FormData) {
  const returnTo = getReturnToPath(formData);

  try {
    const actor = await getCurrentUserForAction();

    const id = parsePositiveInt(getInputValue(formData, "id"));
    if (!id) {
      throw new Error("Registro inválido para edição.");
    }

    const existing = await prisma.controleTemperaturaEquipamento.findUnique({
      where: { id }
    });

    if (!existing) {
      throw new Error("Registro não encontrado.");
    }

    const existingPeriod = getMonthYear(existing.data);
    if (await isMonthSigned(existingPeriod.mes, existingPeriod.ano)) {
      throw new Error("O mês deste registro já foi fechado e não pode ser editado.");
    }
    if (!canEditRecordDate(actor, "modulo.temperatura", existing.data, getTodaySystemDate())) {
      throw new Error("Seu perfil não pode editar este registro de temperatura.");
    }

    const registroPayload = await getRegistroPayload(formData, actor.nomeCompleto);
    const { turnosConferencia, ...payload } = registroPayload;

    if (payload.equipamento !== existing.equipamento) {
      ensureEquipmentSupportsShift(turnosConferencia, existing.turno);
    }

    await ensureUniqueTemperatureMeasurement({
      equipamento: payload.equipamento,
      data: existing.data,
      turno: existing.turno,
      ignoreId: existing.id
    });

    const registroEmOperacao =
      payload.statusOperacionalEquipamento === StatusOperacionalEquipamento.EM_OPERACAO;
    const fotoDesvio = registroEmOperacao
      ? await parseImageUploadFromFormData({
          formData,
          key: "fotoDesvio",
          maxBytes: TEMPERATURE_EVIDENCE_IMAGE_MAX_BYTES
        })
      : null;
    const exigeFoto = registroEmOperacao && isCorrectiveActionRequired(payload.status);
    const temFotoExistente =
      registroEmOperacao &&
      hasStoredImage({
        url: existing.fotoUrl,
        mimeType: existing.fotoMimeType,
        base64: existing.fotoBase64
      });

    if (exigeFoto && !fotoDesvio && !temFotoExistente) {
      throw new Error(
        "Anexe uma foto da evidência para salvar este registro."
      );
    }
    const fotoArmazenada = fotoDesvio
      ? await saveTemperatureEquipmentEvidenceImage(fotoDesvio)
      : null;

    await prisma.controleTemperaturaEquipamento.update({
      where: { id },
      data: {
        ...payload,
        turno: existing.turno,
        ...(!registroEmOperacao
          ? {
              fotoNome: null,
              fotoMimeType: null,
              fotoBase64: null,
              fotoUrl: null,
              fotoTamanhoBytes: null,
              fotoCriadoEm: null,
              fotoCriadoPorUsuarioId: null
            }
          : fotoDesvio && fotoArmazenada
          ? {
              fotoNome: fotoDesvio.fileName,
              fotoMimeType: fotoArmazenada.mimeType,
              fotoBase64: null,
              fotoUrl: fotoArmazenada.url,
              fotoTamanhoBytes: fotoArmazenada.size,
              fotoCriadoEm: fotoArmazenada.createdAt,
              fotoCriadoPorUsuarioId: actor.id
            }
          : {})
      }
    });

    revalidateModulePaths();
    redirectWithFeedback(returnTo, "success", "Registro Atualizado com Sucesso.");
  } catch (error) {
    rethrowIfRedirectError(error);
    redirectWithFeedback(
      returnTo,
      "error",
      getErrorMessage(error, "Não foi possível salvar o registro. Verifique os campos obrigatórios.")
    );
  }
}

export async function deleteRegistroAction(formData: FormData) {
  const returnTo = getReturnToPath(formData);

  try {
    const actor = await getCurrentUserForAction();
    ensurePermission(actor, "modulo.temperatura.excluir_registro", "Seu perfil não pode excluir registros de temperatura.");

    const id = parsePositiveInt(getInputValue(formData, "id"));
    if (!id) {
      throw new Error("Registro inválido para exclusão.");
    }

    const existing = await prisma.controleTemperaturaEquipamento.findUnique({
      where: { id }
    });

    if (!existing) {
      throw new Error("Registro não encontrado.");
    }

    if (!canEditRecordDate(actor, "modulo.temperatura", existing.data, getTodaySystemDate())) {
      throw new Error(
        "Registros históricos não podem ser editados. Apenas registros do dia atual podem ser ajustados."
      );
    }

    const { mes, ano } = getMonthYear(existing.data);
    if (await isMonthSigned(mes, ano)) {
      throw new Error(
        "O mês deste registro já foi fechado e o item não pode ser excluído."
      );
    }

    await prisma.controleTemperaturaEquipamento.delete({ where: { id } });

    revalidateModulePaths();
    redirectWithFeedback(returnTo, "success", "Registro Excluído com Sucesso.");
  } catch (error) {
    rethrowIfRedirectError(error);
    redirectWithFeedback(
      returnTo,
      "error",
      getErrorMessage(error, "Não foi possível processar a operação.")
    );
  }
}

export async function closeMonthAction(formData: FormData) {
  const returnTo = getReturnToPath(formData);

  try {
    const actor = await getCurrentUserForAction();
    ensurePermission(actor, "modulo.temperatura.fechar_mes", "Seu perfil não pode assinar fechamento mensal de temperatura.");

    const mes = parsePositiveInt(getInputValue(formData, "mes"));
    const ano = parsePositiveInt(getInputValue(formData, "ano"));
    const senhaConfirmacao = getInputValue(formData, "senhaConfirmacao");
    const responsavelTecnico = actor.nomeCompleto;

    if (!mes || mes < 1 || mes > 12 || !ano) {
      throw new Error("Informe um mês e ano válidos para fechamento.");
    }

    await validateSignaturePassword({ user: actor, password: senhaConfirmacao });

    const dataAssinatura = getCurrentSystemDateTime();

    const signed = await isMonthSigned(mes, ano);
    if (signed) {
      throw new Error(`O mês ${String(mes).padStart(2, "0")}/${ano} já está assinado.`);
    }

    const { start, end } = getMonthDateRange(mes, ano);
    const quantidadeRegistros = await prisma.controleTemperaturaEquipamento.count({
      where: {
        data: {
          gte: start,
          lte: end
        }
      }
    });

    if (quantidadeRegistros === 0) {
      throw new Error("Não há registros no período selecionado para fechamento.");
    }

    await prisma.controleTemperaturaEquipamentoFechamento.upsert({
      where: { mes_ano: { mes, ano } },
      create: {
        mes,
        ano,
        responsavelTecnico,
        dataAssinatura,
        status: StatusFechamentoTemperaturaEquipamento.ASSINADO
      },
      update: {
        responsavelTecnico,
        dataAssinatura,
        status: StatusFechamentoTemperaturaEquipamento.ASSINADO
      }
    });
    await createSignatureLog({
      user: actor,
      tipo: "FECHAMENTO_MENSAL",
      modulo: "controle-temperatura-equipamentos",
      referenciaId: `${mes}-${ano}`
    });

    revalidateModulePaths();
    redirectWithFeedback(
      returnTo,
      "success",
      `Mês ${String(mes).padStart(2, "0")}/${ano} Fechado com Sucesso.`
    );
  } catch (error) {
    rethrowIfRedirectError(error);
    redirectWithFeedback(
      returnTo,
      "error",
      getErrorMessage(error, "Não foi possível fechar o mês. Verifique se ainda existem pendências.")
    );
  }
}

export async function reopenMonthAction(formData: FormData) {
  const returnTo = getReturnToPath(formData);

  try {
    const actor = await getCurrentUserForAction();
    ensurePermission(actor, "modulo.temperatura.reabrir_mes", "Seu perfil não pode reabrir períodos de temperatura.");

    const mes = parsePositiveInt(getInputValue(formData, "mes"));
    const ano = parsePositiveInt(getInputValue(formData, "ano"));

    if (!mes || mes < 1 || mes > 12 || !ano) {
      throw new Error("Informe um mês e ano válidos para reabertura.");
    }

    const fechamento = await prisma.controleTemperaturaEquipamentoFechamento.findUnique({
      where: { mes_ano: { mes, ano } }
    });

    if (
      !fechamento ||
      fechamento.status !== StatusFechamentoTemperaturaEquipamento.ASSINADO
    ) {
      throw new Error(`O mês ${String(mes).padStart(2, "0")}/${ano} não está assinado.`);
    }

    await prisma.controleTemperaturaEquipamentoFechamento.update({
      where: { id: fechamento.id },
      data: {
        status: StatusFechamentoTemperaturaEquipamento.ABERTO
      }
    });

    revalidateModulePaths();
    redirectWithFeedback(
      returnTo,
      "success",
      `Mês ${String(mes).padStart(2, "0")}/${ano} Reaberto com Sucesso.`
    );
  } catch (error) {
    rethrowIfRedirectError(error);
    redirectWithFeedback(
      returnTo,
      "error",
      getErrorMessage(error, "Não foi possível processar a operação.")
    );
  }
}

export async function signRegistroNutricionistaAction(formData: FormData) {
  const returnTo = getReturnToPath(formData);

  try {
    const actor = await getCurrentUserForAction();
    ensurePermission(actor, "modulo.temperatura.assinar_historico", "Você não tem permissão para assinar o histórico de temperatura.");

    const id = parsePositiveInt(getInputValue(formData, "id"));
    const senhaConfirmacao = getInputValue(formData, "senhaConfirmacao");
    if (!id) {
      throw new Error("Registro inválido para assinatura do supervisor.");
    }

    const registro = await prisma.controleTemperaturaEquipamento.findUnique({
      where: { id },
      select: {
        id: true,
        assinaturaNutricionistaDataHora: true
      }
    });

    if (!registro) {
      throw new Error("Registro não encontrado.");
    }

    if (registro.assinaturaNutricionistaDataHora) {
      throw new Error("Este registro já foi assinado pelo supervisor.");
    }

    await validateSignaturePassword({ user: actor, password: senhaConfirmacao });

    const now = getCurrentSystemDateTime();
    await prisma.controleTemperaturaEquipamento.update({
      where: { id },
      data: {
        assinaturaNutricionistaUsuarioId: actor.id,
        assinaturaNutricionistaNome: actor.nomeCompleto,
        assinaturaNutricionistaPerfil: actor.perfil,
        assinaturaNutricionistaDataHora: now
      }
    });

    await createSignatureLog({
      user: actor,
      tipo: "REVISAO_NUTRICIONISTA",
      modulo: "controle-temperatura-equipamentos/registro",
      referenciaId: String(id)
    });

    revalidateModulePaths();
    redirectWithFeedback(returnTo, "success", "Registro assinado com sucesso.");
  } catch (error) {
    rethrowIfRedirectError(error);
    redirectWithFeedback(
      returnTo,
      "error",
      getErrorMessage(
        error,
        "Não foi possível assinar a conferência como revisada pelo supervisor."
      )
    );
  }
}

export async function createCatalogOptionAction(formData: FormData) {
  const returnTo = getReturnToPath(formData);

  try {
    const actor = await getCurrentUserForAction();
    ensurePermission(actor, "modulo.temperatura.gerenciar_cadastros", "Você não tem permissão para gerenciar cadastros de temperatura.");

    const tipo = parseOptionType(getInputValue(formData, "tipo"));
    const nome = sanitizeCatalogName(getInputValue(formData, "nome"));

    if (!tipo) {
      throw new Error("Tipo de opção inválido.");
    }

    if (!nome) {
      throw new Error("Informe o nome da opção para cadastro.");
    }

    const optionExists = await hasCatalogOptionWithSameName(tipo, nome);
    if (optionExists) {
      throw new Error("Esta opção já está cadastrada.");
    }

    const categoriaEquipamento =
      tipo === TipoOpcaoTemperaturaEquipamento.EQUIPAMENTO
        ? parseEquipmentCategory(getInputValue(formData, "categoriaEquipamento"))
        : null;

    if (tipo === TipoOpcaoTemperaturaEquipamento.EQUIPAMENTO && !categoriaEquipamento) {
      throw new Error("Selecione a categoria do equipamento.");
    }

    const turnosConferencia =
      tipo === TipoOpcaoTemperaturaEquipamento.EQUIPAMENTO
        ? parseConfiguredShiftsFromFormData(formData)
        : { turnoManha: true, turnoTarde: true };

    await prisma.controleTemperaturaEquipamentoOpcao.create({
      data: {
        tipo,
        nome,
        categoriaEquipamento,
        ...turnosConferencia,
        ativo: true
      }
    });

    revalidateModulePaths();
    redirectWithFeedback(returnTo, "success", "Opção Cadastrada com Sucesso.");
  } catch (error) {
    rethrowIfRedirectError(error);
    redirectWithFeedback(
      returnTo,
      "error",
      getErrorMessage(error, "Não foi possível processar a operação.")
    );
  }
}

export async function updateCatalogOptionAction(formData: FormData) {
  const returnTo = getReturnToPath(formData);

  try {
    const actor = await getCurrentUserForAction();
    ensurePermission(actor, "modulo.temperatura.gerenciar_cadastros", "Você não tem permissão para gerenciar cadastros de temperatura.");

    const optionId = parsePositiveInt(getInputValue(formData, "optionId"));
    if (!optionId) {
      throw new Error("Opção inválida para edição.");
    }

    const option = await prisma.controleTemperaturaEquipamentoOpcao.findUnique({
      where: { id: optionId }
    });

    if (!option) {
      throw new Error("Opção não encontrada.");
    }

    const nome = sanitizeCatalogName(getInputValue(formData, "nome"));
    if (!nome) {
      throw new Error("Informe o nome da opção.");
    }

    const optionExists = await hasCatalogOptionWithSameName(option.tipo, nome, optionId);
    if (optionExists) {
      throw new Error("Já existe outra opção com este nome.");
    }

    const categoriaEquipamento =
      option.tipo === TipoOpcaoTemperaturaEquipamento.EQUIPAMENTO
        ? parseEquipmentCategory(getInputValue(formData, "categoriaEquipamento"))
        : null;

    if (option.tipo === TipoOpcaoTemperaturaEquipamento.EQUIPAMENTO && !categoriaEquipamento) {
      throw new Error("Selecione a categoria do equipamento.");
    }

    const turnosConferencia =
      option.tipo === TipoOpcaoTemperaturaEquipamento.EQUIPAMENTO
        ? parseConfiguredShiftsFromFormData(formData)
        : null;
    const ativoInput = getInputValue(formData, "ativo");
    const ativo =
      ativoInput === "true" ? true : ativoInput === "false" ? false : option.ativo;

    await prisma.$transaction(async (tx) => {
      await tx.controleTemperaturaEquipamentoOpcao.update({
        where: { id: optionId },
        data: {
          nome,
          categoriaEquipamento,
          ativo,
          ...(turnosConferencia ?? {})
        }
      });

      if (option.nome !== nome) {
        if (option.tipo === TipoOpcaoTemperaturaEquipamento.EQUIPAMENTO) {
          await tx.controleTemperaturaEquipamento.updateMany({
            where: { equipamento: option.nome },
            data: { equipamento: nome }
          });
        }

        if (option.tipo === TipoOpcaoTemperaturaEquipamento.ACAO_CORRETIVA) {
          await tx.controleTemperaturaEquipamento.updateMany({
            where: { acaoCorretiva: option.nome },
            data: { acaoCorretiva: nome }
          });
        }
      }
    });

    revalidateModulePaths();
    redirectWithFeedback(returnTo, "success", "Opção Atualizada com Sucesso.");
  } catch (error) {
    rethrowIfRedirectError(error);
    redirectWithFeedback(
      returnTo,
      "error",
      getErrorMessage(error, "Não foi possível processar a operação.")
    );
  }
}

export async function toggleCatalogOptionStatusAction(formData: FormData) {
  const returnTo = getReturnToPath(formData);

  try {
    const actor = await getCurrentUserForAction();
    ensurePermission(actor, "modulo.temperatura.gerenciar_cadastros", "Você não tem permissão para gerenciar cadastros de temperatura.");

    const optionId = parsePositiveInt(getInputValue(formData, "optionId"));
    if (!optionId) {
      throw new Error("Opção inválida para atualização.");
    }

    const option = await prisma.controleTemperaturaEquipamentoOpcao.findUnique({
      where: { id: optionId }
    });

    if (!option) {
      throw new Error("Opção não encontrada.");
    }

    const nextStatus = getInputValue(formData, "ativo") === "true";

    await prisma.controleTemperaturaEquipamentoOpcao.update({
      where: { id: optionId },
      data: { ativo: nextStatus }
    });

    revalidateModulePaths();
    redirectWithFeedback(
      returnTo,
      "success",
      nextStatus ? "Opção Ativada com Sucesso." : "Opção Inativada com Sucesso."
    );
  } catch (error) {
    rethrowIfRedirectError(error);
    redirectWithFeedback(
      returnTo,
      "error",
      getErrorMessage(error, "Não foi possível processar a operação.")
    );
  }
}

export async function updateCategoryParameterAction(formData: FormData) {
  const returnTo = getReturnToPath(formData);

  try {
    const actor = await getCurrentUserForAction();
    ensurePermission(actor, "modulo.temperatura.gerenciar_cadastros", "Você não tem permissão para gerenciar cadastros de temperatura.");

    const parameterId = parsePositiveInt(getInputValue(formData, "parameterId"));
    if (!parameterId) {
      throw new Error("Parâmetro de categoria inválido para edição.");
    }

    const parameter = await prisma.controleTemperaturaCategoriaParametro.findUnique({
      where: { id: parameterId }
    });

    if (!parameter) {
      throw new Error("Parâmetro de categoria não encontrado.");
    }

    const nome = sanitizeCatalogName(getInputValue(formData, "nome"));
    const acaoIdeal = sanitizeCatalogName(getInputValue(formData, "acaoIdeal"));
    const acaoAlerta = sanitizeCatalogName(getInputValue(formData, "acaoAlerta"));
    const acaoCritica = sanitizeCatalogName(getInputValue(formData, "acaoCritica"));
    const orientacaoCorretivaPadrao = sanitizeCatalogName(
      getInputValue(formData, "orientacaoCorretivaPadrao")
    );

    if (!nome) {
      throw new Error("Informe o nome da categoria.");
    }

    if (!orientacaoCorretivaPadrao) {
      throw new Error("Informe a orientação corretiva padrão da categoria.");
    }

    if (!acaoIdeal || !acaoAlerta || !acaoCritica) {
      throw new Error(
        "Preencha as ações corretivas de Ideal, Alerta e Crítica para a categoria."
      );
    }

    const temperaturaIdealMin = parseTemperatureField(formData, "temperaturaIdealMin");
    const temperaturaIdealMax = parseTemperatureField(formData, "temperaturaIdealMax");
    const temperaturaAlertaMin = parseTemperatureField(formData, "temperaturaAlertaMin");
    const temperaturaAlertaMax = parseTemperatureField(formData, "temperaturaAlertaMax");
    const temperaturaCriticaMin = parseTemperatureField(formData, "temperaturaCriticaMin");
    const temperaturaCriticaMax = parseTemperatureField(formData, "temperaturaCriticaMax");

    validateRangeBounds(temperaturaIdealMin, temperaturaIdealMax, "ideal");
    validateRangeBounds(temperaturaAlertaMin, temperaturaAlertaMax, "alerta");
    validateRangeBounds(temperaturaCriticaMin, temperaturaCriticaMax, "crítica");

    if (temperaturaIdealMin === null && temperaturaIdealMax === null) {
      throw new Error("Configure ao menos um limite para a faixa ideal.");
    }

    if (temperaturaAlertaMin === null && temperaturaAlertaMax === null) {
      throw new Error("Configure ao menos um limite para a faixa de alerta.");
    }

    const isActive = getInputValue(formData, "isActive") === "true";

    await prisma.controleTemperaturaCategoriaParametro.update({
      where: { id: parameterId },
      data: {
        nome,
        temperaturaIdealMin,
        temperaturaIdealMax,
        temperaturaAlertaMin,
        temperaturaAlertaMax,
        temperaturaCriticaMin,
        temperaturaCriticaMax,
        acaoIdeal,
        acaoAlerta,
        acaoCritica,
        orientacaoCorretivaPadrao,
        isActive
      }
    });

    revalidateModulePaths();
    redirectWithFeedback(
      returnTo,
      "success",
      "Parâmetros da Categoria Atualizados com Sucesso."
    );
  } catch (error) {
    rethrowIfRedirectError(error);
    redirectWithFeedback(
      returnTo,
      "error",
      getErrorMessage(error, "Não foi possível processar a operação.")
    );
  }
}

export async function createCategoryRuleAction(formData: FormData) {
  const returnTo = getReturnToPath(formData);

  try {
    const actor = await getCurrentUserForAction();
    ensurePermission(actor, "modulo.temperatura.gerenciar_cadastros", "Você não tem permissão para gerenciar cadastros de temperatura.");

    const categoriaId = parsePositiveInt(getInputValue(formData, "categoriaId"));
    if (!categoriaId) {
      throw new Error("Categoria inválida para criar regra.");
    }

    const categoria = await prisma.controleTemperaturaCategoriaParametro.findUnique({
      where: { id: categoriaId }
    });

    if (!categoria) {
      throw new Error("Categoria não encontrada.");
    }

    const temperaturaMin = parseTemperatureField(formData, "temperaturaMin");
    const temperaturaMax = parseTemperatureField(formData, "temperaturaMax");
    const status = parseStatusValue(getInputValue(formData, "status"));
    const acaoCorretiva = sanitizeCatalogName(getInputValue(formData, "acaoCorretiva"));
    const ordem = parsePositiveInt(getInputValue(formData, "ordem"));
    const isActive = getInputValue(formData, "isActive") !== "false";

    if (temperaturaMin === null && temperaturaMax === null) {
      throw new Error("Informe ao menos temperatura mínima ou máxima para a regra.");
    }

    if (!status) {
      throw new Error("Selecione um status válido para a regra.");
    }

    if (!acaoCorretiva) {
      throw new Error("Informe a ação corretiva da regra.");
    }

    if (!ordem) {
      throw new Error("Informe uma ordem válida para a regra.");
    }

    validateRangeBounds(temperaturaMin, temperaturaMax, "regra");
    await validateRuleOrderAvailability(categoriaId, ordem);

    await prisma.controleTemperaturaCategoriaRegra.create({
      data: {
        categoriaId,
        temperaturaMin,
        temperaturaMax,
        status,
        acaoCorretiva,
        ordem,
        isActive
      }
    });

    revalidateModulePaths();
    redirectWithFeedback(returnTo, "success", "Regra Cadastrada com Sucesso.");
  } catch (error) {
    rethrowIfRedirectError(error);
    redirectWithFeedback(
      returnTo,
      "error",
      getErrorMessage(error, "Não foi possível processar a operação.")
    );
  }
}

export async function updateCategoryRuleAction(formData: FormData) {
  const returnTo = getReturnToPath(formData);

  try {
    const actor = await getCurrentUserForAction();
    ensurePermission(actor, "modulo.temperatura.gerenciar_cadastros", "Você não tem permissão para gerenciar cadastros de temperatura.");

    const regraId = parsePositiveInt(getInputValue(formData, "regraId"));
    if (!regraId) {
      throw new Error("Regra inválida para edição.");
    }

    const regra = await prisma.controleTemperaturaCategoriaRegra.findUnique({
      where: { id: regraId }
    });

    if (!regra) {
      throw new Error("Regra não encontrada.");
    }

    const temperaturaMin = parseTemperatureField(formData, "temperaturaMin");
    const temperaturaMax = parseTemperatureField(formData, "temperaturaMax");
    const status = parseStatusValue(getInputValue(formData, "status"));
    const acaoCorretiva = sanitizeCatalogName(getInputValue(formData, "acaoCorretiva"));
    const ordem = parsePositiveInt(getInputValue(formData, "ordem"));
    const isActive = getInputValue(formData, "isActive") !== "false";

    if (temperaturaMin === null && temperaturaMax === null) {
      throw new Error("Informe ao menos temperatura mínima ou máxima para a regra.");
    }

    if (!status) {
      throw new Error("Selecione um status válido para a regra.");
    }

    if (!acaoCorretiva) {
      throw new Error("Informe a ação corretiva da regra.");
    }

    if (!ordem) {
      throw new Error("Informe uma ordem válida para a regra.");
    }

    validateRangeBounds(temperaturaMin, temperaturaMax, "regra");
    await validateRuleOrderAvailability(regra.categoriaId, ordem, regra.id);

    if (regra.isActive && !isActive) {
      await ensureCategoryHasAnotherActiveRule(regra.categoriaId, regra.id);
    }

    await prisma.controleTemperaturaCategoriaRegra.update({
      where: { id: regra.id },
      data: {
        temperaturaMin,
        temperaturaMax,
        status,
        acaoCorretiva,
        ordem,
        isActive
      }
    });

    revalidateModulePaths();
    redirectWithFeedback(returnTo, "success", "Regra Atualizada com Sucesso.");
  } catch (error) {
    rethrowIfRedirectError(error);
    redirectWithFeedback(
      returnTo,
      "error",
      getErrorMessage(error, "Não foi possível processar a operação.")
    );
  }
}

export async function toggleCategoryRuleStatusAction(formData: FormData) {
  const returnTo = getReturnToPath(formData);

  try {
    const actor = await getCurrentUserForAction();
    ensurePermission(actor, "modulo.temperatura.gerenciar_cadastros", "Você não tem permissão para gerenciar cadastros de temperatura.");

    const regraId = parsePositiveInt(getInputValue(formData, "regraId"));
    if (!regraId) {
      throw new Error("Regra inválida para atualização.");
    }

    const regra = await prisma.controleTemperaturaCategoriaRegra.findUnique({
      where: { id: regraId }
    });

    if (!regra) {
      throw new Error("Regra não encontrada.");
    }

    const nextStatus = getInputValue(formData, "isActive") === "true";

    if (regra.isActive && !nextStatus) {
      await ensureCategoryHasAnotherActiveRule(regra.categoriaId, regra.id);
    }

    await prisma.controleTemperaturaCategoriaRegra.update({
      where: { id: regra.id },
      data: { isActive: nextStatus }
    });

    revalidateModulePaths();
    redirectWithFeedback(
      returnTo,
      "success",
      nextStatus ? "Regra Ativada com Sucesso." : "Regra Inativada com Sucesso."
    );
  } catch (error) {
    rethrowIfRedirectError(error);
    redirectWithFeedback(
      returnTo,
      "error",
      getErrorMessage(error, "Não foi possível processar a operação.")
    );
  }
}

export async function deleteCategoryRuleAction(formData: FormData) {
  const returnTo = getReturnToPath(formData);

  try {
    const actor = await getCurrentUserForAction();
    ensurePermission(actor, "modulo.temperatura.gerenciar_cadastros", "Você não tem permissão para gerenciar cadastros de temperatura.");

    const regraId = parsePositiveInt(getInputValue(formData, "regraId"));
    if (!regraId) {
      throw new Error("Regra inválida para exclusão.");
    }

    const regra = await prisma.controleTemperaturaCategoriaRegra.findUnique({
      where: { id: regraId }
    });

    if (!regra) {
      throw new Error("Regra não encontrada.");
    }

    if (regra.isActive) {
      await ensureCategoryHasAnotherActiveRule(regra.categoriaId, regra.id);
    }

    await prisma.controleTemperaturaCategoriaRegra.delete({
      where: { id: regra.id }
    });

    revalidateModulePaths();
    redirectWithFeedback(returnTo, "success", "Regra Excluída com Sucesso.");
  } catch (error) {
    rethrowIfRedirectError(error);
    redirectWithFeedback(
      returnTo,
      "error",
      getErrorMessage(error, "Não foi possível processar a operação.")
    );
  }
}


