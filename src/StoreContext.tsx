import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useMemo,
} from "react";
import { load, Store } from "@tauri-apps/plugin-store";

export const isTauri = () =>
  typeof window !== "undefined" &&
  Boolean((window as any).__TAURI_INTERNALS__ || (window as any).__TAURI__);

export const StoreContext = createContext<{
  storeValues: { [key: string]: any };
  setStoreValue: (key: string, value: any) => void;
  store: Store | null;
  storeInitialized: boolean;
}>({
  storeValues: {},
  setStoreValue: () => {},
  store: null,
  storeInitialized: false,
});

export const StoreProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [storeValues, setStoreValues] = useState<{ [key: string]: any }>({});
  const [store, setStore] = useState<Store | null>(null);
  const [storeInitialized, setStoreInitialized] = useState(!isTauri());

  useEffect(() => {
    const initializeStore = async () => {
      if (!isTauri()) {
        const values: { [key: string]: any } = {};
        try {
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith("nyx_pref_")) {
              const prefKey = key.replace("nyx_pref_", "");
              try {
                values[prefKey] = JSON.parse(localStorage.getItem(key) || "");
              } catch {
                values[prefKey] = localStorage.getItem(key);
              }
            }
          }
        } catch {}
        setStoreValues(values);
        setStoreInitialized(true);
        return;
      }

      try {
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Store load timeout")), 800)
        );
        const storeInstance = (await Promise.race([
          load("preferences.json"),
          timeoutPromise,
        ])) as Store;
        setStore(storeInstance);

        const keys = await storeInstance.keys();
        const values: { [key: string]: any } = {};
        for (const key of keys) {
          values[key] = await storeInstance.get(key);
        }
        setStoreValues(values);
        setStoreInitialized(true);
      } catch (e) {
        console.warn("Tauri Store fallback to localStorage:", e);
        setStoreInitialized(true);
      }
    };

    initializeStore();
  }, []);

  const setStoreValue = useCallback(
    async (key: string, value: any) => {
      setStoreValues((prevValues) => ({ ...prevValues, [key]: value }));
      if (store) {
        try {
          await store.set(key, value);
          await store.save();
        } catch (e) {
          console.error("Failed to save to Tauri store:", e);
        }
      } else {
        try {
          localStorage.setItem(`nyx_pref_${key}`, JSON.stringify(value));
        } catch {}
      }
    },
    [store]
  );

  const contextValue = useMemo(
    () => ({ storeValues, setStoreValue, store, storeInitialized }),
    [storeValues, setStoreValue, store, storeInitialized]
  );

  if (!storeInitialized) {
    return null;
  }

  return (
    <StoreContext.Provider value={contextValue}>
      {children}
    </StoreContext.Provider>
  );
};

export const useStore = <T,>(
  key: string,
  initialValue: T
): [T, (value: T | ((oldValue: T) => T)) => void, boolean] => {
  const { storeValues, setStoreValue, storeInitialized } =
    useContext(StoreContext);
  const [value, setValue] = useState<T>(storeValues[key] ?? initialValue);

  useEffect(() => {
    if (storeValues[key] !== undefined && storeValues[key] !== value) {
      setValue(storeValues[key]);
    }
  }, [storeValues, key]);

  const setStoredValue = useCallback(
    (newValue: T | ((oldValue: T) => T)) => {
      const valueToStore =
        typeof newValue === "function"
          ? (newValue as (oldValue: T) => T)(value)
          : newValue;
      setValue(valueToStore);
      setStoreValue(key, valueToStore);
    },
    [key, setStoreValue, value]
  );

  return [value, setStoredValue, storeInitialized];
};
