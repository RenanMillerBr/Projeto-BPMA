"use client";

import { useEffect, useMemo, useState } from "react";

import { normalizeOption } from "./options";

type SearchableOptionFieldProps = {
  name: string;
  options: string[];
  defaultValue?: string;
  placeholder: string;
  disabled?: boolean;
  required?: boolean;
  onSelectedValueChange?: (selectedValue: string) => void;
};

export function SearchableOptionField({
  name,
  options,
  defaultValue = "",
  placeholder,
  disabled = false,
  required = false,
  onSelectedValueChange
}: SearchableOptionFieldProps) {
  const [inputValue, setInputValue] = useState(defaultValue);
  const [selectedValue, setSelectedValue] = useState(defaultValue);
  const [isOpen, setIsOpen] = useState(false);

  const filteredOptions = useMemo(() => {
    const normalizedQuery = normalizeOption(inputValue);

    if (!normalizedQuery) {
      return options;
    }

    return options.filter((option) =>
      normalizeOption(option).startsWith(normalizedQuery)
    );
  }, [inputValue, options]);

  const hasExactMatch = useMemo(() => {
    return options.some(
      (option) => normalizeOption(option) === normalizeOption(inputValue)
    );
  }, [inputValue, options]);

  const showValidationHint = inputValue.length > 0 && !hasExactMatch;

  useEffect(() => {
    onSelectedValueChange?.(selectedValue);
  }, [onSelectedValueChange, selectedValue]);

  return (
    <div className="relative mt-1">
      <input type="hidden" name={name} value={selectedValue} readOnly required={required} />
      <input
        type="text"
        value={inputValue}
        disabled={disabled}
        autoComplete="off"
        placeholder={placeholder}
        className="bpma-input"
        onFocus={() => setIsOpen(true)}
        onBlur={() => {
          window.setTimeout(() => {
            setIsOpen(false);
          }, 120);
        }}
        onChange={(event) => {
          const nextValue = event.target.value;
          setInputValue(nextValue);

          const matchingOption =
            options.find(
              (option) => normalizeOption(option) === normalizeOption(nextValue)
            ) ?? "";

          setSelectedValue(matchingOption);
          onSelectedValueChange?.(matchingOption);
        }}
      />

      {isOpen && filteredOptions.length > 0 ? (
        <ul className="absolute z-20 mt-1 max-h-52 w-full overflow-auto rounded-lg border border-slate-200 bg-white p-1 shadow-lg dark:border-slate-700 dark:bg-slate-900">
          {filteredOptions.map((option) => (
            <li key={option}>
              <button
                type="button"
                className="block w-full rounded-md px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-100 dark:text-slate-100 dark:hover:bg-slate-800"
                onMouseDown={(event) => {
                  event.preventDefault();
                }}
                onClick={() => {
                  setInputValue(option);
                  setSelectedValue(option);
                  onSelectedValueChange?.(option);
                  setIsOpen(false);
                }}
              >
                {option}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <span
        className={`mt-1 block text-xs ${
          showValidationHint ? "text-red-600" : "text-slate-500 dark:text-slate-400"
        }`}
      >
        {showValidationHint
          ? "Selecione uma opção existente da lista."
          : "Abra a lista para visualizar todas as opções ou digite para filtrar."}
      </span>
    </div>
  );
}
