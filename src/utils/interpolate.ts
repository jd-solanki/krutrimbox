// Substitutes `{{key}}` placeholders in a template string. Keys may contain dots
// so dotted paths such as `{{steps.review.output}}` resolve against a flattened
// values map (the hook runtime keys Action Outputs as `steps.<id>.output`). A key
// with no matching value renders as an empty string, the established placeholder
// substitution semantics shared by templates, prompts, and Hook Actions.
export type InterpolationValues = Record<string, string | number>;

export function interpolate(template: string, values: InterpolationValues): string {
  return template.replace(/{{([\w.]+)}}/g, (_match, key: string) => {
    const value = values[key];
    return typeof value === "undefined" ? "" : String(value);
  });
}
