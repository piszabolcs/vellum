# Sémák — miért laposak?

Ez a mappa a JSON-sémákat tartalmazza, amiket az `ollamaOneShot` használ.

## A legfontosabb szabály: LAPOS SÉMÁK

A mélyen egymásba ágyazott vagy rekurzív sémák **rontják** a kimenet minőségét a
grammar-kényszerített dekódolásnál. A gyakorlati szabály:

- Maximum egy szint tömb, primitívekből vagy lapos objektumokból
- Ne legyen objektum objektumban objektumban
- Ha összetettebb kell, bontsd két hívásra

## Hogyan működik a kényszerítés

Amikor átadunk egy JSON sémát az Ollama `format` paraméterében, a runtime lefordítja
GBNF grammarrá, és minden generálási lépésnél **nullázza** azoknak a tokeneknek a
valószínűségét, amik sértenék a sémát.

Vagyis a rossz formátum nem "ritka", hanem **fizikailag lehetetlen**.

Ez az alapja:
- a routernek (F7)
- a memória-tanulásnak (F3)
- a compactionnek (F5)
- a rerank pontozásnak (F8)
- a tool-argumentumoknak (F6)

## Ismert buktató

Egyes gondolkodásra képes modelleknél a `think: false` **csendben eldobhatja** a
format kényszert.

Ezért az F1 részeként le kell futtatni a `scripts/check-structured-output.ts`
szkriptet, ami a beállított modellel teszteli mindkét módot, és az eredményt
dokumentálni kell a README-ben.

## Új séma hozzáadása

1. Írd meg a Zod sémát az `index.ts`-ben
2. Exportáld a típust (`z.infer`)
3. Exportáld a JSON sémát a `toJsonSchema` segédfüggvénnyel
4. A `$refStrategy: 'none'` kötelező — ne legyen `$ref` a kimenetben

```ts
export const MySchema = z.object({
  field: z.string().max(200),
});

export type MyParsed = z.infer<typeof MySchema>;
export const MyJsonSchema = toJsonSchema(MySchema, 'My');
```
