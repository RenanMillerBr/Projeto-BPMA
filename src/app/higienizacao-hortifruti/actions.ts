"use server";

import { StatusFechamentoHortifruti, TipoOpcaoHigienizacao } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { rethrowIfRedirectError } from "@/lib/redirect-error";

import { getCurrentUserForAction } from "@/lib/auth-session";
import {
  createSignatureLog,
  ensureCanCloseMonth,
  ensureCanDeleteOperationalRecords,
  ensureCanManageOptions,
  ensureCanReopenMonth,
  validateSignaturePassword
} from "@/lib/authz";
import { prisma } from "@/lib/prisma";

import {
  findCatalogOptionByName,
  hasCatalogOptionWithSameName,
  parseOptionType,
  sanitizeCatalogName
} from "./catalog";
import {
  getCurrentSystemDateTime,
  getDurationInMinutes,
  getMonthDateRange,
  getMonthYear,
  parseDateInput,
  parsePositiveInt
} from "./utils";

const MODULE_PATH = "/higienizacao-hortifruti";

type FeedbackType = "success" | "error";

function getInputValue(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
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
    url.searchParams.delete("deleteId");
  }
  url.searchParams.set("feedbackType", feedbackType);
  url.searchParams.set("feedback", feedback);

  redirect(`${url.pathname}?${url.searchParams.toString()}`);
}

async function isMonthSigned(mes: number, ano: number): Promise<boolean> {
  const fechamento = await prisma.higienizacaoHortifrutiFechamento.findUnique({
    where: { mes_ano: { mes, ano } }
  });

  return fechamento?.status === StatusFechamentoHortifruti.ASSINADO;
}

async function getRegistroPayload(formData: FormData, responsavelLogado: string) {
  const hortifrutiInput = getInputValue(formData, "hortifruti");
  const produtoInput = getInputValue(formData, "produtoUtilizado");
  const inicioProcesso = getInputValue(formData, "inicioProcesso");
  const terminoProcesso = getInputValue(formData, "terminoProcesso");
  const observacoes = getInputValue(formData, "observacoes");

  if (!hortifrutiInput || !produtoInput) {
    throw new Error("Preencha todos os campos obrigatórios do registro.");
  }

  if (!responsavelLogado.trim()) {
    throw new Error("Não foi possível identificar o usuário logado para o campo Responsável.");
  }

  const hortifruti = await findCatalogOptionByName(
    TipoOpcaoHigienizacao.HORTIFRUTI,
    hortifrutiInput
  );
  if (!hortifruti) {
    throw new Error("Selecione uma opção válida no campo Hortifruti.");
  }

  const produtoUtilizado = await findCatalogOptionByName(
    TipoOpcaoHigienizacao.PRODUTO_UTILIZADO,
    produtoInput
  );
  if (!produtoUtilizado) {
    throw new Error("Selecione uma opção válida no campo Produto Utilizado.");
  }

  const duracaoMinutos = getDurationInMinutes(inicioProcesso, terminoProcesso);
  if (duracaoMinutos === null) {
    throw new Error("Informe horários válidos no formato HH:MM.");
  }

  if (duracaoMinutos < 0) {
    throw new Error(
      "O término do processo não pode ser menor que o início do processo."
    );
  }

  return {
    hortifruti,
    produtoUtilizado,
    inicioProcesso,
    terminoProcesso,
    duracaoMinutos,
    responsavel: responsavelLogado.trim(),
    observacoes: observacoes || null
  };
}

export async function createRegistroAction(formData: FormData) {
  const returnTo = getReturnToPath(formData);

  try {
    const actor = await getCurrentUserForAction();

    const dataInput = getInputValue(formData, "data");
    const data = /^\d{4}-\d{2}-\d{2}$/.test(dataInput)
      ? parseDateInput(dataInput)
      : null;
    if (!data) {
      throw new Error("Informe uma data válida para o registro.");
    }

    const payload = await getRegistroPayload(formData, actor.nomeCompleto);
    const { mes, ano } = getMonthYear(data);

    if (await isMonthSigned(mes, ano)) {
      throw new Error(
        `O mês ${String(mes).padStart(2, "0")}/${ano} já está fechado e não aceita novos registros.`
      );
    }

    await prisma.higienizacaoHortifruti.create({
      data: {
        ...payload,
        data
      }
    });

    revalidatePath(MODULE_PATH);
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

    const existing = await prisma.higienizacaoHortifruti.findUnique({
      where: { id }
    });

    if (!existing) {
      throw new Error("Registro não encontrado.");
    }

    if (actor.perfil === "COLABORADOR") {
      throw new Error("Você não possui permissão para editar este registro.");
    }

    const existingPeriod = getMonthYear(existing.data);
    if (await isMonthSigned(existingPeriod.mes, existingPeriod.ano)) {
      throw new Error("O mês deste registro já foi fechado e não pode ser editado.");
    }

    const payload = await getRegistroPayload(formData, actor.nomeCompleto);

    await prisma.higienizacaoHortifruti.update({
      where: { id },
      data: payload
    });

    revalidatePath(MODULE_PATH);
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
    ensureCanDeleteOperationalRecords(actor);

    const id = parsePositiveInt(getInputValue(formData, "id"));
    if (!id) {
      throw new Error("Registro inválido para exclusão.");
    }

    const existing = await prisma.higienizacaoHortifruti.findUnique({
      where: { id }
    });

    if (!existing) {
      throw new Error("Registro não encontrado.");
    }

    const { mes, ano } = getMonthYear(existing.data);
    if (await isMonthSigned(mes, ano)) {
      throw new Error(
        "O mês deste registro já foi fechado e o item não pode ser excluído."
      );
    }

    await prisma.higienizacaoHortifruti.delete({ where: { id } });

    revalidatePath(MODULE_PATH);
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
    ensureCanCloseMonth(actor);

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
    const quantidadeRegistros = await prisma.higienizacaoHortifruti.count({
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

    await prisma.higienizacaoHortifrutiFechamento.upsert({
      where: { mes_ano: { mes, ano } },
      create: {
        mes,
        ano,
        responsavelTecnico,
        dataAssinatura,
        status: StatusFechamentoHortifruti.ASSINADO
      },
      update: {
        responsavelTecnico,
        dataAssinatura,
        status: StatusFechamentoHortifruti.ASSINADO
      }
    });
    await createSignatureLog({
      user: actor,
      tipo: "FECHAMENTO_MENSAL",
      modulo: "higienizacao-hortifruti",
      referenciaId: `${mes}-${ano}`
    });

    revalidatePath(MODULE_PATH);
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
    ensureCanReopenMonth(actor);

    const mes = parsePositiveInt(getInputValue(formData, "mes"));
    const ano = parsePositiveInt(getInputValue(formData, "ano"));

    if (!mes || mes < 1 || mes > 12 || !ano) {
      throw new Error("Informe um mês e ano válidos para reabertura.");
    }

    const fechamento = await prisma.higienizacaoHortifrutiFechamento.findUnique({
      where: { mes_ano: { mes, ano } }
    });

    if (!fechamento || fechamento.status !== StatusFechamentoHortifruti.ASSINADO) {
      throw new Error(`O mês ${String(mes).padStart(2, "0")}/${ano} não está assinado.`);
    }

    await prisma.higienizacaoHortifrutiFechamento.update({
      where: { id: fechamento.id },
      data: {
        status: StatusFechamentoHortifruti.ABERTO
      }
    });

    revalidatePath(MODULE_PATH);
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

export async function createCatalogOptionAction(formData: FormData) {
  const returnTo = getReturnToPath(formData);

  try {
    const actor = await getCurrentUserForAction();
    ensureCanManageOptions(actor);

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

    await prisma.higienizacaoHortifrutiOpcao.create({
      data: { tipo, nome }
    });

    revalidatePath(MODULE_PATH);
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

export async function deleteCatalogOptionAction(formData: FormData) {
  const returnTo = getReturnToPath(formData);

  try {
    const actor = await getCurrentUserForAction();
    ensureCanManageOptions(actor);

    const optionId = parsePositiveInt(getInputValue(formData, "optionId"));
    if (!optionId) {
      throw new Error("Opção inválida para exclusão.");
    }

    const option = await prisma.higienizacaoHortifrutiOpcao.findUnique({
      where: { id: optionId }
    });

    if (!option) {
      throw new Error("Opção não encontrada.");
    }

    if (option.tipo === TipoOpcaoHigienizacao.HORTIFRUTI) {
      const usageCount = await prisma.higienizacaoHortifruti.count({
        where: { hortifruti: option.nome }
      });

      if (usageCount > 0) {
        throw new Error(
          "Não é possível excluir esta opção de Hortifruti porque ela já está em uso nos registros."
        );
      }
    } else {
      const usageCount = await prisma.higienizacaoHortifruti.count({
        where: { produtoUtilizado: option.nome }
      });

      if (usageCount > 0) {
        throw new Error(
          "Não é possível excluir esta opção de Produto Utilizado porque ela já está em uso nos registros."
        );
      }
    }

    await prisma.higienizacaoHortifrutiOpcao.delete({ where: { id: optionId } });

    revalidatePath(MODULE_PATH);
    redirectWithFeedback(returnTo, "success", "Opção Excluída com Sucesso.");
  } catch (error) {
    rethrowIfRedirectError(error);
    redirectWithFeedback(
      returnTo,
      "error",
      getErrorMessage(error, "Não foi possível processar a operação.")
    );
  }
}


