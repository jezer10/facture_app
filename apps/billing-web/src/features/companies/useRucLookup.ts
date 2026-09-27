import { onBeforeUnmount, ref, watch, type Ref } from 'vue';
import { companyApi, validRuc, type CompanyData, type TaxpayerLookup } from './api';
export function useRucLookup(form: CompanyData, editing: Ref<boolean>, step: Ref<number>) {
  const lookup = ref<TaxpayerLookup | null>(null),
    searching = ref(false),
    lookupError = ref('');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let generation = 0;
  let lastAuto: { ruc: string; name: string; address: string } | undefined;
  function cancel() {
    clearTimeout(timer);
    controller?.abort();
    generation++;
    searching.value = false;
  }
  async function search() {
    cancel();
    if (!editing.value || step.value !== 0 || !validRuc(form.ruc)) return;
    const version = generation,
      ruc = form.ruc,
      name = form.legalName,
      address = form.address;
    controller = new AbortController();
    searching.value = true;
    lookupError.value = '';
    lookup.value = null;
    try {
      const result = await companyApi.lookup(
        ruc,
        AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
      );
      if (version !== generation || form.ruc !== ruc) return;
      lookup.value = result;
      if (result.taxpayer) {
        // Preserve edits made while the request was in flight.
        if (form.legalName === name && (!name || (lastAuto?.ruc === ruc && name === lastAuto.name)))
          form.legalName = result.taxpayer.legalName;
        if (
          form.address === address &&
          result.taxpayer.address &&
          (!address || (lastAuto?.ruc === ruc && address === lastAuto.address))
        )
          form.address = result.taxpayer.address;
        lastAuto = { ruc, name: result.taxpayer.legalName, address: result.taxpayer.address };
      }
    } catch {
      if (version === generation)
        lookupError.value =
          'No pudimos consultar el padrón. Reintenta o completa los datos manualmente; seguirán sujetos a revisión.';
    } finally {
      if (version === generation) searching.value = false;
    }
  }
  watch([() => form.ruc, editing, step], ([ruc, active, currentStep], [previousRuc]) => {
    cancel();
    lookup.value = null;
    lookupError.value = '';
    if (ruc !== previousRuc && lastAuto && lastAuto.ruc === previousRuc) {
      if (form.legalName === lastAuto.name) form.legalName = '';
      if (form.address === lastAuto.address) form.address = '';
      lastAuto = undefined;
    }
    if (active && currentStep === 0 && validRuc(ruc)) timer = setTimeout(() => void search(), 450);
  });
  onBeforeUnmount(cancel);
  return { lookup, searching, lookupError, search };
}
