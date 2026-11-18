import { Atom } from "effect/reactivity";
import { appAtomRegistry } from "../../state/atom-registry";
import type { HeaderUsageTarget } from "./headerUsageTarget";

export const headerUsageTargetAtom = Atom.make<HeaderUsageTarget | null>(null).pipe(Atom.keepAlive);

export function rememberHeaderUsageTarget(target: HeaderUsageTarget) {
  const previous = appAtomRegistry.get(headerUsageTargetAtom);
  if (
    previous?.environmentId === target.environmentId &&
    previous.providerInstanceId === target.providerInstanceId
  )
    return;
  appAtomRegistry.set(headerUsageTargetAtom, target);
}
