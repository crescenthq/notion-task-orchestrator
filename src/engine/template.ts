const TEMPLATE_RE = /\{\{(\w+)\}\}/g;

export function resolveTemplate(template: string, variables: Record<string, string>): string {
  return template.replace(TEMPLATE_RE, (match, name: string) => {
    return name in variables ? variables[name] : match;
  });
}

export function hasTemplateVars(text: string): boolean {
  return TEMPLATE_RE.test(text);
}
