import "dotenv/config";

import { Prisma, PrismaClient } from "@prisma/client";

type TargetNote = {
  notaFiscal: string;
  fornecedor: string;
};

type PlannedNote = {
  id: number;
  data: Date;
  fornecedor: string;
  notaFiscal: string;
  chaveNfe: string | null;
  cnpjFornecedor: string | null;
  serieNota: string | null;
  identificadorFiscal: string | null;
  statusNota: string;
  origemXml: boolean;
  itemCount: number;
};

type PeriodKey = {
  mes: number;
  ano: number;
};

const TARGET_NOTES: TargetNote[] = [
  {
    notaFiscal: "29757",
    fornecedor: "THERMAC CONTROLES INDUSTRIAIS LTDA"
  },
  {
    notaFiscal: "36",
    fornecedor: "SALESIO VIEIRA HORTIFRUTI LTDA"
  },
  {
    notaFiscal: "45726",
    fornecedor: "CROISSANTS DE FRANCE COMERCIO DE MASSAS LTDA"
  }
];

const MODULE_CODE = "rastreabilidade";
const NOTE_SPECIFIC_LOG_MODULES = [
  "rastreabilidade-recebimento/nota",
  "rastreabilidade-recebimento/registro"
] as const;

const prisma = new PrismaClient();

function parseArgs(): { execute: boolean; help: boolean } {
  const args = process.argv.slice(2);
  const allowedArgs = new Set(["--execute", "--dry-run", "-h", "--help"]);
  const invalidArgs = args.filter((arg) => !allowedArgs.has(arg));

  if (invalidArgs.length > 0) {
    throw new Error(`Argumentos invalidos: ${invalidArgs.join(", ")}`);
  }

  return {
    execute: args.includes("--execute"),
    help: args.includes("-h") || args.includes("--help")
  };
}

function printUsage() {
  console.log("Uso:");
  console.log("  npm run limpar:notas:kplatz");
  console.log("  npm run limpar:notas:kplatz -- --execute");
  console.log("");
  console.log("Sem --execute o script roda somente em dry-run.");
}

function normalizeText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

function targetKey(target: TargetNote): string {
  return `${target.notaFiscal.trim()}|${normalizeText(target.fornecedor)}`;
}

function noteKey(note: { notaFiscal: string; fornecedor: string }): string {
  return `${note.notaFiscal.trim()}|${normalizeText(note.fornecedor)}`;
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function getPeriodKey(date: Date): PeriodKey {
  return {
    mes: date.getUTCMonth() + 1,
    ano: date.getUTCFullYear()
  };
}

function uniqueValues<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function uniquePeriods(dates: Date[]): PeriodKey[] {
  const periods = new Map<string, PeriodKey>();

  for (const date of dates) {
    const period = getPeriodKey(date);
    periods.set(`${period.ano}-${period.mes}`, period);
  }

  return Array.from(periods.values());
}

function getNoteSpecificLogWhere(noteIds: number[]): Prisma.LogAssinaturaWhereInput {
  return {
    referenciaId: { in: noteIds.map(String) },
    OR: NOTE_SPECIFIC_LOG_MODULES.flatMap((moduleName) => [
      { modulo: moduleName },
      { modulo: { startsWith: `${moduleName}/` } }
    ])
  };
}

function getAmbiguousRastreabilidadeLogWhere(
  noteIds: number[]
): Prisma.LogAssinaturaWhereInput {
  return {
    referenciaId: { in: noteIds.map(String) },
    modulo: { startsWith: "rastreabilidade" },
    NOT: getNoteSpecificLogWhere(noteIds)
  };
}

function assertDatabaseUrlIsConfigured() {
  if (!process.env.DATABASE_URL?.trim()) {
    throw new Error("DATABASE_URL nao esta configurada no ambiente.");
  }
}

async function resolveTargetNotes(): Promise<PlannedNote[]> {
  const targetNumbers = uniqueValues(TARGET_NOTES.map((target) => target.notaFiscal));
  const targetsByKey = new Map(TARGET_NOTES.map((target) => [targetKey(target), target]));

  if (targetsByKey.size !== TARGET_NOTES.length) {
    throw new Error("A lista de notas alvo possui entradas duplicadas.");
  }

  const candidates = await prisma.rastreabilidadeRecebimentoNota.findMany({
    where: {
      notaFiscal: { in: targetNumbers }
    },
    include: {
      _count: {
        select: { itens: true }
      }
    },
    orderBy: [{ notaFiscal: "asc" }, { fornecedor: "asc" }, { id: "asc" }]
  });

  const plannedNotes: PlannedNote[] = [];
  const errors: string[] = [];

  for (const target of TARGET_NOTES) {
    const byNumber = candidates.filter(
      (candidate) => candidate.notaFiscal.trim() === target.notaFiscal
    );
    const matching = byNumber.filter(
      (candidate) => noteKey(candidate) === targetKey(target)
    );

    if (matching.length === 0) {
      const foundSuppliers = byNumber.length
        ? byNumber
            .map((candidate) => `ID ${candidate.id}: ${candidate.fornecedor}`)
            .join("; ")
        : "nenhum fornecedor encontrado para este numero";
      errors.push(
        `NF ${target.notaFiscal} / ${target.fornecedor}: nao encontrada com fornecedor esperado (${foundSuppliers}).`
      );
      continue;
    }

    if (matching.length > 1) {
      errors.push(
        `NF ${target.notaFiscal} / ${target.fornecedor}: encontrada mais de uma vez (${matching
          .map((candidate) => candidate.id)
          .join(", ")}).`
      );
      continue;
    }

    const note = matching[0];
    plannedNotes.push({
      id: note.id,
      data: note.data,
      fornecedor: note.fornecedor,
      notaFiscal: note.notaFiscal,
      chaveNfe: note.chaveNfe,
      cnpjFornecedor: note.cnpjFornecedor,
      serieNota: note.serieNota,
      identificadorFiscal: note.identificadorFiscal,
      statusNota: note.statusNota,
      origemXml: note.origemXml,
      itemCount: note._count.itens
    });
  }

  if (errors.length > 0) {
    throw new Error(`Divergencias encontradas:\n- ${errors.join("\n- ")}`);
  }

  const selectedIds = uniqueValues(plannedNotes.map((note) => note.id));
  if (plannedNotes.length !== TARGET_NOTES.length || selectedIds.length !== TARGET_NOTES.length) {
    throw new Error("A resolucao das notas alvo nao retornou exatamente 3 IDs unicos.");
  }

  return plannedNotes;
}

async function collectPlan(plannedNotes: PlannedNote[]) {
  const noteIds = plannedNotes.map((note) => note.id);
  const targetNumbers = uniqueValues(TARGET_NOTES.map((target) => target.notaFiscal));
  const targetKeys = new Set(TARGET_NOTES.map(targetKey));
  const noteById = new Map(plannedNotes.map((note) => [note.id, note]));
  const noteDates = uniqueValues(plannedNotes.map((note) => note.data.getTime())).map(
    (time) => new Date(time)
  );
  const periods = uniquePeriods(plannedNotes.map((note) => note.data));

  const [
    linkedItems,
    sameNumberItemsOutsideSelectedNotes,
    noteSpecificLogs,
    ambiguousRastreabilidadeLogs,
    dailySignatures,
    standardMonthlyClosures,
    legacyMonthlyClosures
  ] = await Promise.all([
    prisma.rastreabilidadeRecebimentoRegistro.findMany({
      where: { notaId: { in: noteIds } },
      orderBy: [{ notaId: "asc" }, { id: "asc" }]
    }),
    prisma.rastreabilidadeRecebimentoRegistro.findMany({
      where: {
        notaFiscal: { in: targetNumbers },
        OR: [{ notaId: null }, { notaId: { notIn: noteIds } }]
      },
      orderBy: [{ notaFiscal: "asc" }, { fornecedor: "asc" }, { id: "asc" }]
    }),
    prisma.logAssinatura.findMany({
      where: getNoteSpecificLogWhere(noteIds),
      orderBy: [{ id: "asc" }]
    }),
    prisma.logAssinatura.findMany({
      where: getAmbiguousRastreabilidadeLogWhere(noteIds),
      orderBy: [{ id: "asc" }]
    }),
    prisma.assinaturaDiariaModulo.findMany({
      where: {
        moduloCodigo: MODULE_CODE,
        dataReferencia: { in: noteDates }
      },
      orderBy: [{ dataReferencia: "asc" }, { id: "asc" }]
    }),
    periods.length
      ? prisma.fechamentoMensalModulo.findMany({
          where: {
            OR: periods.map((period) => ({
              moduloCodigo: MODULE_CODE,
              ano: period.ano,
              mes: period.mes
            }))
          },
          orderBy: [{ ano: "asc" }, { mes: "asc" }, { id: "asc" }]
        })
      : [],
    periods.length
      ? prisma.rastreabilidadeRecebimentoFechamento.findMany({
          where: {
            OR: periods.map((period) => ({
              ano: period.ano,
              mes: period.mes
            }))
          },
          orderBy: [{ ano: "asc" }, { mes: "asc" }, { id: "asc" }]
        })
      : []
  ]);

  const outsideTargetItems = sameNumberItemsOutsideSelectedNotes.filter((item) =>
    targetKeys.has(noteKey(item))
  );

  const itemValidationErrors = linkedItems.flatMap((item) => {
    const note = item.notaId ? noteById.get(item.notaId) : null;
    if (!note) {
      return [`Item ${item.id}: notaId ${item.notaId ?? "null"} nao pertence ao plano.`];
    }

    if (item.notaFiscal.trim() !== note.notaFiscal.trim()) {
      return [
        `Item ${item.id}: notaFiscal ${item.notaFiscal} diverge da nota ${note.id} (${note.notaFiscal}).`
      ];
    }

    if (normalizeText(item.fornecedor) !== normalizeText(note.fornecedor)) {
      return [
        `Item ${item.id}: fornecedor ${item.fornecedor} diverge da nota ${note.id} (${note.fornecedor}).`
      ];
    }

    return [];
  });

  if (itemValidationErrors.length > 0) {
    throw new Error(
      `Itens vinculados com divergencia:\n- ${itemValidationErrors.join("\n- ")}`
    );
  }

  if (outsideTargetItems.length > 0) {
    throw new Error(
      [
        "Foram encontrados registros de recebimento com a mesma NF/fornecedor fora das notas selecionadas.",
        "Isso indica relacao importante nao mapeada para exclusao automatica.",
        ...outsideTargetItems.map(
          (item) =>
            `Item ${item.id}: notaId ${item.notaId ?? "null"}, NF ${item.notaFiscal}, fornecedor ${item.fornecedor}`
        )
      ].join("\n")
    );
  }

  if (ambiguousRastreabilidadeLogs.length > 0) {
    throw new Error(
      [
        "Foram encontrados logs de assinatura de rastreabilidade com referenciaId igual ao ID de nota, mas modulo nao especifico de nota.",
        "Mapeie estes logs antes de executar a limpeza.",
        ...ambiguousRastreabilidadeLogs.map(
          (log) => `Log ${log.id}: modulo ${log.modulo}, referenciaId ${log.referenciaId ?? "-"}`
        )
      ].join("\n")
    );
  }

  return {
    linkedItems,
    noteSpecificLogs,
    dailySignatures,
    standardMonthlyClosures,
    legacyMonthlyClosures
  };
}

function countItemsByNoteId(items: Array<{ notaId: number | null }>): Map<number, number> {
  const counts = new Map<number, number>();

  for (const item of items) {
    if (item.notaId === null) {
      continue;
    }
    counts.set(item.notaId, (counts.get(item.notaId) ?? 0) + 1);
  }

  return counts;
}

function printPlan(
  plannedNotes: PlannedNote[],
  plan: Awaited<ReturnType<typeof collectPlan>>,
  execute: boolean
) {
  const itemCountsByNoteId = countItemsByNoteId(plan.linkedItems);

  console.log("Limpeza pontual de notas importadas - KPlatz/BPMA");
  console.log(`Modo: ${execute ? "EXECUCAO REAL" : "DRY-RUN"}`);
  console.log("");
  console.log("Notas alvo localizadas:");
  for (const note of plannedNotes) {
    console.log(
      `- ID ${note.id} | NF ${note.notaFiscal} | ${note.fornecedor} | data ${formatDate(
        note.data
      )} | status ${note.statusNota} | origemXml ${note.origemXml ? "sim" : "nao"}`
    );
    console.log(
      `  CNPJ: ${note.cnpjFornecedor ?? "-"} | serie: ${note.serieNota ?? "-"} | chave: ${
        note.chaveNfe ?? "-"
      } | identificador: ${note.identificadorFiscal ?? "-"}`
    );
    console.log(
      `  Itens vinculados: ${itemCountsByNoteId.get(note.id) ?? 0} (count da relacao: ${
        note.itemCount
      })`
    );
  }

  console.log("");
  console.log("Modelos/tabelas mapeadas:");
  console.log("- RastreabilidadeRecebimentoNota -> rastreabilidade_recebimento_nota");
  console.log("- RastreabilidadeRecebimentoRegistro -> rastreabilidade_recebimento_registro");
  console.log("- LogAssinatura -> log_assinatura (somente logs especificos de nota, se existirem)");
  console.log("- AssinaturaDiariaModulo -> assinatura_diaria_modulo (periodo, preservada)");
  console.log("- FechamentoMensalModulo -> fechamento_mensal_modulo (periodo, preservada)");
  console.log(
    "- RastreabilidadeRecebimentoFechamento -> rastreabilidade_recebimento_fechamento (periodo, preservada)"
  );

  console.log("");
  console.log("Quantidades relacionadas:");
  console.log(`- Itens/registros vinculados por notaId: ${plan.linkedItems.length}`);
  console.log(`- Logs especificos de nota: ${plan.noteSpecificLogs.length}`);
  console.log(`- Assinaturas diarias do periodo (nao serao apagadas): ${plan.dailySignatures.length}`);
  console.log(
    `- Fechamentos mensais padrao do periodo (nao serao apagados): ${plan.standardMonthlyClosures.length}`
  );
  console.log(
    `- Fechamentos legados de rastreabilidade do periodo (nao serao apagados): ${plan.legacyMonthlyClosures.length}`
  );

  console.log("");
  console.log("Ordem planejada de exclusao:");
  console.log("1. LogAssinatura especifico de nota, se houver");
  console.log("2. RastreabilidadeRecebimentoRegistro com notaId nos IDs alvo");
  console.log("3. RastreabilidadeRecebimentoNota com IDs alvo");
  console.log("");
}

async function executeDeletion(
  plannedNotes: PlannedNote[],
  plan: Awaited<ReturnType<typeof collectPlan>>
) {
  const noteIds = plannedNotes.map((note) => note.id);
  const expectedItems = plan.linkedItems.length;
  const expectedLogs = plan.noteSpecificLogs.length;

  const result = await prisma.$transaction(
    async (tx) => {
      const deletedLogs = await tx.logAssinatura.deleteMany({
        where: getNoteSpecificLogWhere(noteIds)
      });

      if (deletedLogs.count !== expectedLogs) {
        throw new Error(
          `Rollback: quantidade de logs mudou entre dry-run e execucao (${expectedLogs} -> ${deletedLogs.count}).`
        );
      }

      const deletedItems = await tx.rastreabilidadeRecebimentoRegistro.deleteMany({
        where: { notaId: { in: noteIds } }
      });

      if (deletedItems.count !== expectedItems) {
        throw new Error(
          `Rollback: quantidade de itens mudou entre dry-run e execucao (${expectedItems} -> ${deletedItems.count}).`
        );
      }

      const deletedNotes = await tx.rastreabilidadeRecebimentoNota.deleteMany({
        where: { id: { in: noteIds } }
      });

      if (deletedNotes.count !== plannedNotes.length) {
        throw new Error(
          `Rollback: quantidade de notas removidas divergiu do plano (${plannedNotes.length} -> ${deletedNotes.count}).`
        );
      }

      return {
        logs: deletedLogs.count,
        itens: deletedItems.count,
        notas: deletedNotes.count
      };
    },
    { timeout: 60_000 }
  );

  const remainingTargetIds = await prisma.rastreabilidadeRecebimentoNota.count({
    where: { id: { in: noteIds } }
  });

  if (remainingTargetIds !== 0) {
    throw new Error(`Validacao final falhou: ${remainingTargetIds} notas alvo ainda existem.`);
  }

  console.log("Exclusao real concluida.");
  console.log("");
  console.log("Notas excluidas:");
  for (const note of plannedNotes) {
    console.log(`- ID ${note.id} | NF ${note.notaFiscal} | ${note.fornecedor}`);
  }
  console.log("");
  console.log("Quantidades excluidas:");
  console.log(`- LogAssinatura: ${result.logs}`);
  console.log(`- RastreabilidadeRecebimentoRegistro: ${result.itens}`);
  console.log(`- RastreabilidadeRecebimentoNota: ${result.notas}`);
  console.log("");
  console.log(
    `Confirmacao: nenhum DELETE foi executado fora dos IDs de nota alvo (${noteIds.join(", ")}).`
  );
}

async function main() {
  const { execute, help } = parseArgs();

  if (help) {
    printUsage();
    return;
  }

  assertDatabaseUrlIsConfigured();

  const plannedNotes = await resolveTargetNotes();
  const plan = await collectPlan(plannedNotes);

  printPlan(plannedNotes, plan, execute);

  if (!execute) {
    console.log("Dry-run concluido. Nenhum dado foi apagado.");
    console.log("Para executar de verdade, rode: npm run limpar:notas:kplatz -- --execute");
    return;
  }

  await executeDeletion(plannedNotes, plan);
}

main()
  .catch((error) => {
    console.error("Operacao abortada com seguranca.");
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
