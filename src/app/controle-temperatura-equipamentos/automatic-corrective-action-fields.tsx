"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { SearchableOptionField } from "./searchable-option-field";
import { normalizeOption } from "./options";
import {
  CategoriaTemperatura,
  findMatchingTemperatureRule,
  getOperationalStatusLabel,
  getShiftLabel,
  getStatusLabel,
  isOperationalTemperatureStatus,
  parseTemperatureInput,
  RegraTemperaturaCategoria,
  StatusOperacionalTemperatura,
  TurnoTemperatura
} from "./utils";

type EquipamentoCategoria = {
  nome: string;
  categoria: CategoriaTemperatura;
};

type RegraCategoriaComTipo = RegraTemperaturaCategoria & {
  categoria: CategoriaTemperatura;
};

type RegistroDuplicidade = {
  id: number;
  equipamento: string;
  turno: TurnoTemperatura;
  href: string;
};

type EquipamentoTurnos = {
  nome: string;
  turnos: TurnoTemperatura[];
};

type AutomaticCorrectiveActionFieldsProps = {
  equipamentoOptions: string[];
  equipamentosCategoria: EquipamentoCategoria[];
  equipamentosTurnos: EquipamentoTurnos[];
  regrasCategoria: RegraCategoriaComTipo[];
  registrosDuplicidade?: RegistroDuplicidade[];
  defaultEquipamento?: string;
  defaultTurno?: TurnoTemperatura;
  allowTurnoSelection?: boolean;
  defaultTemperatura?: string;
  defaultAcaoCorretiva?: string | null;
  defaultStatusOperacional?: StatusOperacionalTemperatura;
  inputClassName: string;
};

const STATUS_OPERACIONAL_OPTIONS: Array<{
  value: StatusOperacionalTemperatura;
  label: string;
}> = [
  { value: "EM_OPERACAO", label: "Em Operação" },
  { value: "MANUTENCAO", label: "Manutenção" },
  { value: "INATIVO", label: "Inativo" }
];

const SHIFT_OPTIONS: Array<{ value: TurnoTemperatura; label: string }> = [
  { value: "MANHA", label: "Manhã" },
  { value: "TARDE", label: "Tarde" }
];

export function AutomaticCorrectiveActionFields({
  equipamentoOptions,
  equipamentosCategoria,
  equipamentosTurnos,
  regrasCategoria,
  registrosDuplicidade = [],
  defaultEquipamento = "",
  defaultTurno = "MANHA",
  allowTurnoSelection = true,
  defaultTemperatura = "",
  defaultAcaoCorretiva = null,
  defaultStatusOperacional = "EM_OPERACAO",
  inputClassName
}: AutomaticCorrectiveActionFieldsProps) {
  const statusInputRef = useRef<HTMLInputElement | null>(null);
  const [equipamentoSelecionado, setEquipamentoSelecionado] = useState(defaultEquipamento);
  const [turnoSelecionado, setTurnoSelecionado] = useState<TurnoTemperatura>(defaultTurno);
  const [temperaturaInput, setTemperaturaInput] = useState(defaultTemperatura);
  const [statusOperacional, setStatusOperacional] =
    useState<StatusOperacionalTemperatura>(defaultStatusOperacional);
  const equipamentoEmOperacao = isOperationalTemperatureStatus(statusOperacional);

  const categoriaPorEquipamento = useMemo(() => {
    const map = new Map<string, CategoriaTemperatura>();

    for (const equipamento of equipamentosCategoria) {
      map.set(equipamento.nome, equipamento.categoria);
    }

    return map;
  }, [equipamentosCategoria]);

  const turnosPorEquipamento = useMemo(() => {
    const map = new Map<string, TurnoTemperatura[]>();

    for (const equipamento of equipamentosTurnos) {
      map.set(equipamento.nome, equipamento.turnos);
    }

    return map;
  }, [equipamentosTurnos]);

  const turnosDisponiveis = useMemo(() => {
    const configuredShifts = turnosPorEquipamento.get(equipamentoSelecionado);

    return configuredShifts && configuredShifts.length > 0
      ? configuredShifts
      : SHIFT_OPTIONS.map((option) => option.value);
  }, [equipamentoSelecionado, turnosPorEquipamento]);

  const regrasPorCategoria = useMemo(() => {
    const map = new Map<CategoriaTemperatura, RegraCategoriaComTipo[]>();

    for (const regra of regrasCategoria) {
      const rules = map.get(regra.categoria) ?? [];
      rules.push(regra);
      map.set(regra.categoria, rules);
    }

    return map;
  }, [regrasCategoria]);

  useEffect(() => {
    if (!allowTurnoSelection) {
      setTurnoSelecionado(defaultTurno);
      return;
    }

    if (!turnosDisponiveis.includes(turnoSelecionado)) {
      setTurnoSelecionado(turnosDisponiveis[0] ?? "MANHA");
    }
  }, [allowTurnoSelection, defaultTurno, turnoSelecionado, turnosDisponiveis]);

  const avaliacao = useMemo(() => {
    if (!equipamentoEmOperacao) {
      return {
        statusValue: "",
        statusLabel: "",
        acaoCorretiva: ""
      };
    }

    const categoria = categoriaPorEquipamento.get(equipamentoSelecionado);
    const temperatura = parseTemperatureInput(temperaturaInput);

    if (!categoria || temperatura === null) {
      return {
        statusValue: "",
        statusLabel: "",
        acaoCorretiva: defaultAcaoCorretiva ?? ""
      };
    }

    const regras = regrasPorCategoria.get(categoria) ?? [];
    const regraCorrespondente = findMatchingTemperatureRule(temperatura, regras);

    if (!regraCorrespondente) {
      return {
        statusValue: "",
        statusLabel: "",
        acaoCorretiva: defaultAcaoCorretiva ?? ""
      };
    }

    return {
      statusValue: regraCorrespondente.status,
      statusLabel: getStatusLabel(regraCorrespondente.status),
      acaoCorretiva: regraCorrespondente.acaoCorretiva
    };
  }, [
    categoriaPorEquipamento,
    defaultAcaoCorretiva,
    equipamentoEmOperacao,
    equipamentoSelecionado,
    regrasPorCategoria,
    temperaturaInput
  ]);

  const registroDuplicado = useMemo(() => {
    const equipamentoNormalizado = normalizeOption(equipamentoSelecionado);

    if (!equipamentoNormalizado) {
      return null;
    }

    return (
      registrosDuplicidade.find(
        (registro) =>
          normalizeOption(registro.equipamento) === equipamentoNormalizado &&
          registro.turno === turnoSelecionado
      ) ?? null
    );
  }, [equipamentoSelecionado, registrosDuplicidade, turnoSelecionado]);

  useEffect(() => {
    const input = statusInputRef.current;
    if (!input) {
      return;
    }

    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, [avaliacao.statusValue]);

  useEffect(() => {
    const input = statusInputRef.current;
    const form = input?.form;
    if (!input || !form) {
      return;
    }

    const handleSubmit = (event: Event) => {
      if (!registroDuplicado) {
        input.setCustomValidity("");
        return;
      }

      input.setCustomValidity(
        "Este equipamento já possui registro para este dia/turno."
      );
      event.preventDefault();
      event.stopPropagation();
      input.reportValidity();
    };

    const submitButtons = Array.from(
      form.querySelectorAll<HTMLButtonElement>('button[type="submit"]')
    );

    for (const button of submitButtons) {
      if (registroDuplicado) {
        button.disabled = true;
        button.classList.add("cursor-not-allowed", "opacity-60");
      } else if (button.dataset.temperatureDuplicateDisabled === "true") {
        button.disabled = false;
        button.classList.remove("cursor-not-allowed", "opacity-60");
        delete button.dataset.temperatureDuplicateDisabled;
      }

      if (registroDuplicado) {
        button.dataset.temperatureDuplicateDisabled = "true";
      }
    }

    if (!registroDuplicado) {
      input.setCustomValidity("");
    }

    form.addEventListener("submit", handleSubmit);

    return () => {
      form.removeEventListener("submit", handleSubmit);
      for (const button of submitButtons) {
        if (button.dataset.temperatureDuplicateDisabled === "true") {
          button.disabled = false;
          button.classList.remove("cursor-not-allowed", "opacity-60");
          delete button.dataset.temperatureDuplicateDisabled;
        }
      }
    };
  }, [registroDuplicado]);

  return (
    <>
      <label className="text-sm text-slate-700 dark:text-slate-200">
        Equipamento *
        <SearchableOptionField
          name="equipamento"
          options={equipamentoOptions}
          defaultValue={defaultEquipamento}
          placeholder="Digite para buscar..."
          required
          onSelectedValueChange={setEquipamentoSelecionado}
        />
      </label>

      {allowTurnoSelection ? (
        <label className="text-sm text-slate-700 dark:text-slate-200">
          Turno *
          <select
            name="turno"
            value={turnoSelecionado}
            required
            className={inputClassName}
            onChange={(event) => {
              setTurnoSelecionado(event.target.value as TurnoTemperatura);
            }}
          >
            {SHIFT_OPTIONS.filter((option) => turnosDisponiveis.includes(option.value)).map(
              (option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              )
            )}
          </select>
          <span className="mt-1 block text-xs text-slate-500 dark:text-slate-400">
            {equipamentoSelecionado && turnosDisponiveis.length === 1
              ? `Este equipamento gera pendência apenas no turno ${getShiftLabel(turnosDisponiveis[0] ?? "MANHA")}.`
              : "Selecione um turno configurado para este equipamento."}
          </span>
        </label>
      ) : (
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-700 dark:bg-slate-800">
          <input type="hidden" name="turno" value={turnoSelecionado} readOnly />
          <p className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
            Turno
          </p>
          <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">
            {getShiftLabel(turnoSelecionado)}
          </p>
        </div>
      )}

      <label className="text-sm text-slate-700 dark:text-slate-200">
        Status do equipamento *
        <select
          name="statusOperacionalEquipamento"
          value={statusOperacional}
          required
          className={inputClassName}
          onChange={(event) => {
            const nextStatus = event.target.value as StatusOperacionalTemperatura;
            setStatusOperacional(nextStatus);

            if (!isOperationalTemperatureStatus(nextStatus)) {
              setTemperaturaInput("");
            }
          }}
        >
          {STATUS_OPERACIONAL_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      {equipamentoEmOperacao ? (
        <label className="text-sm text-slate-700 dark:text-slate-200">
          Temperatura Aferida (°C) *
          <input
            type="text"
            name="temperaturaAferida"
            required
            inputMode="text"
            placeholder="Ex.: 4,0"
            value={temperaturaInput}
            className={inputClassName}
            onChange={(event) => {
              setTemperaturaInput(event.target.value);
            }}
          />
        </label>
      ) : (
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">
          <p className="font-medium text-slate-800 dark:text-slate-100">
            Temperatura: Não aplicável
          </p>
          <p className="mt-1 text-xs">
            Quando o equipamento está em manutenção ou inativo, a aferição de temperatura não é necessária para este registro.
          </p>
        </div>
      )}

      <label className="text-sm text-slate-700 dark:text-slate-200 md:col-span-2">
        Ação Corretiva (Automática)
        <input
          ref={statusInputRef}
          type="hidden"
          name="statusCalculado"
          value={avaliacao.statusValue}
          readOnly
        />
        <input type="hidden" name="acaoCorretiva" value={avaliacao.acaoCorretiva} readOnly />
        <input
          type="text"
          value={equipamentoEmOperacao ? avaliacao.acaoCorretiva : "Não aplicável"}
          readOnly
          className={`${inputClassName} cursor-not-allowed bg-slate-100 dark:bg-slate-700`}
          placeholder="Será preenchida automaticamente"
        />
        <span className="mt-1 block text-xs text-slate-500 dark:text-slate-400">
          {!equipamentoEmOperacao
            ? `Status operacional: ${getOperationalStatusLabel(statusOperacional)}. O equipamento não será considerado pendente neste registro.`
            : avaliacao.statusLabel
            ? `Status calculado automaticamente: ${avaliacao.statusLabel}.`
            : "Preencha equipamento e temperatura para calcular automaticamente."}
        </span>
      </label>

      {registroDuplicado ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 md:col-span-2 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
          <p>
            Já existe registro deste equipamento para o turno {getShiftLabel(turnoSelecionado)}.
          </p>
          <a href={registroDuplicado.href} className="mt-2 inline-flex text-sm font-medium underline">
            Abrir registro existente
          </a>
        </div>
      ) : null}
    </>
  );
}
