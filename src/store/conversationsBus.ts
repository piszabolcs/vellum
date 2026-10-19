/**
 * Pici ertesito csatorna a beszelgetes-lista frissitesehez.
 *
 * A chat store akkor is valtoztat a listan, amikor a lista nem tud rola: uj
 * beszelgetes jon letre, vagy megjon az automatikus cim. A ket store kozvetlen
 * osszekotese korkoros importot adna (a lista valtaskor a chat store-t hivja),
 * ezert mindketto ezt a semleges modult hasznalja.
 */

type Listener = () => void;

const listeners = new Set<Listener>();

/** feliratkozas; a visszaadott fuggveny leiratkozik */
export function subscribeConversations(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** jelzi, hogy a beszelgetes-lista elavult */
export function notifyConversationsChanged(): void {
  listeners.forEach((listener) => listener());
}
