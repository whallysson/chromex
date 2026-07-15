export function validateJsonInput(schema, value, path = '$') {
  if (!schema || typeof schema !== 'object') return [];
  const errors = [];
  if (Array.isArray(schema.required)) {
    for (const key of schema.required) if (!(key in value)) errors.push(`${path}.${key} is required`);
  }
  if (schema.type === 'object' && (!value || typeof value !== 'object' || Array.isArray(value))) errors.push(`${path} must be an object`);
  if (schema.properties && value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      const property = schema.properties[key];
      if (!property) {
        if (schema.additionalProperties === false) errors.push(`${path}.${key} is not allowed`);
        continue;
      }
      errors.push(...validateJsonValue(property, item, `${path}.${key}`));
    }
  }
  return errors;
}

function validateJsonValue(schema, value, path) {
  const errors = [];
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length && !types.some(type => matchesType(type, value))) errors.push(`${path} must be ${types.join(' or ')}`);
  if (schema.enum && !schema.enum.some(item => Object.is(item, value))) errors.push(`${path} must be one of ${schema.enum.join(', ')}`);
  if (schema.type === 'object' && value && typeof value === 'object' && !Array.isArray(value)) errors.push(...validateJsonInput(schema, value, path));
  if (schema.type === 'array' && Array.isArray(value) && schema.items) {
    value.forEach((item, index) => errors.push(...validateJsonValue(schema.items, item, `${path}[${index}]`)));
  }
  return errors;
}

function matchesType(type, value) {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return !!value && typeof value === 'object' && !Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  return typeof value === type;
}
