import { NodeConnectionTypes, NodeOperationError, OperationalError, UserError } from 'n8n-workflow';
import type { IDataObject, IExecuteFunctions, INodeExecutionData, INodeProperties, INodeType, INodeTypeDescription } from 'n8n-workflow';

const models = [
  'grok-imagine-video-1.5-fast:reverse',
  'grok-imagine-video:reverse',
  'grok-imagine-video:official',
  'grok-imagine-video-1.5:official',
];
const ratios = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'];
const resolutions = ['480p', '720p', '1080p'];
const privateFields = new Set([
  'request', 'request_body', 'user_id', 'actor_user_id', 'credential_id',
  'authorization_id', 'application_id', 'api_key', 'api_token', 'token',
  'credential', 'credentials', 'access_token', 'refresh_token', 'authorization',
  'headers', 'supplier', 'supplier_id', 'provider_route', 'upstream',
  'upstream_model', 'actual_model', 'secret',
]);

const properties: INodeProperties[] = [
  {
    displayName: 'Resource', name: 'resource', type: 'options', default: 'video', noDataExpression: true,
    options: [{ name: 'Task', value: 'task' }, { name: 'Video', value: 'video' }],
  },
  {
    displayName: 'Operation', name: 'operation', type: 'options', default: 'create', noDataExpression: true,
    displayOptions: { show: { resource: ['video'] } },
    options: [{ name: 'Create', value: 'create', action: 'Create a video', description: 'Submit one paid video generation task' }],
  },
  {
    displayName: 'Operation', name: 'operation', type: 'options', default: 'get', noDataExpression: true,
    displayOptions: { show: { resource: ['task'] } },
    options: [
      { name: 'Get', value: 'get', action: 'Get a task', description: 'Query one existing task' },
      { name: 'Get Many', value: 'getMany', action: 'Get many tasks', description: 'Query up to 50 existing task IDs' },
    ],
  },
  {
    displayName: 'Model', name: 'model', type: 'options', default: 'grok-imagine-video-1.5-fast:reverse',
    displayOptions: { show: { resource: ['video'] } },
    options: [
      { name: 'Grok Imagine Video 1.5 Fast', value: models[0] },
      { name: 'Grok Imagine Video Standard', value: models[1] },
      { name: 'Grok Imagine Video Official', value: models[2] },
      { name: 'Grok Imagine Video 1.5 Official', value: models[3] },
    ],
    description: 'The model determines the current price and supported input modes',
  },
  {
    displayName: 'Prompt', name: 'prompt', type: 'string', default: '',
    typeOptions: { rows: 4 }, displayOptions: { show: { resource: ['video'] } },
    description: 'Describe the video; required for text-to-video',
  },
  {
    displayName: 'Image URL', name: 'imageUrl', type: 'string', default: '',
    displayOptions: { show: { resource: ['video'] } },
    description: 'Optional authorized public HTTPS image for image-to-video; required for the 1.5 Official model',
  },
  {
    displayName: 'Reference Image URLs', name: 'referenceImageUrls', type: 'string', default: '',
    displayOptions: { show: { resource: ['video'] } },
    description: 'Optional public HTTPS reference images, separated by commas or new lines',
  },
  {
    displayName: 'Aspect Ratio', name: 'aspectRatio', type: 'options', default: '16:9',
    displayOptions: { show: { resource: ['video'] } },
    options: [
      { name: '1:1', value: '1:1' }, { name: '16:9', value: '16:9' },
      { name: '2:3', value: '2:3' }, { name: '3:2', value: '3:2' },
      { name: '3:4', value: '3:4' }, { name: '4:3', value: '4:3' }, { name: '9:16', value: '9:16' },
    ],
    description: 'Output video aspect ratio',
  },
  {
    displayName: 'Resolution', name: 'resolution', type: 'options', default: '480p',
    displayOptions: { show: { resource: ['video'] } },
    options: [
      { name: '480p', value: '480p' }, { name: '720p', value: '720p' }, { name: '1080p', value: '1080p' },
    ],
    description: 'Output resolution; price may vary by model and resolution',
  },
  {
    displayName: 'Duration (Seconds)', name: 'duration', type: 'number', default: 6,
    typeOptions: { minValue: 1, maxValue: 30 },
    displayOptions: { show: { resource: ['video'] } },
    description: 'Fast 1.5 supports 6 to 30 seconds; other models support 1 to 15 seconds',
  },
  {
    displayName: 'Task ID', name: 'taskId', type: 'string', default: '', required: true,
    displayOptions: { show: { resource: ['task'], operation: ['get'] } },
    description: 'The task ID returned by Create',
  },
  {
    displayName: 'Task IDs', name: 'taskIds', type: 'string', default: '', required: true,
    displayOptions: { show: { resource: ['task'], operation: ['getMany'] } },
    description: 'One to 50 existing task IDs, separated by commas or new lines',
  },
];

function object(value: unknown): IDataObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as IDataObject : {};
}

function text(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.length > maximum)
    throw new UserError(`${label} must be at most ${maximum} characters`);
  return value.trim();
}

function requiredText(value: unknown, label: string, maximum: number): string {
  const result = text(value, label, maximum);
  if (!result) throw new UserError(`${label} is required`);
  return result;
}

function publicUrl(value: string): string {
  if (!URL.canParse(value)) throw new UserError('Each image URL must be public HTTPS');
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password)
    throw new UserError('Each image URL must be public HTTPS without embedded credentials');
  return parsed.toString();
}

function referenceUrls(value: unknown): string[] {
  const urls = text(value, 'Reference Image URLs', 8192).split(/[,\n]/).map(v => v.trim()).filter(Boolean);
  if (urls.length > 8) throw new UserError('Provide at most eight reference image URLs');
  return urls.map(publicUrl);
}

function taskIds(value: unknown): string[] {
  const ids = requiredText(value, 'Task IDs', 4096).split(/[,\n]/).map(v => v.trim()).filter(Boolean);
  if (ids.length < 1 || ids.length > 50) throw new UserError('Provide one to 50 task IDs');
  return ids.map(id => requiredText(id, 'Task ID', 128));
}

export function videoBody(get: (name: string) => unknown): IDataObject {
  const model = requiredText(get('model'), 'Model', 80);
  if (!models.includes(model)) throw new UserError('Select a supported Grok Video model');
  const prompt = text(get('prompt'), 'Prompt', 4000);
  const image = text(get('imageUrl'), 'Image URL', 2048);
  if (!prompt && !image) throw new UserError('Prompt or Image URL is required');
  if (model === models[3] && !image) throw new UserError('Grok Imagine Video 1.5 Official requires Image URL');
  const duration = get('duration');
  const limit = model === models[0] ? 30 : 15;
  const minimum = model === models[0] ? 6 : 1;
  if (typeof duration !== 'number' || !Number.isInteger(duration) || duration < minimum || duration > limit)
    throw new UserError(`Duration must be an integer from ${minimum} to ${limit} for this model`);
  const ratio = requiredText(get('aspectRatio'), 'Aspect Ratio', 10);
  if (!ratios.includes(ratio)) throw new UserError('Select a supported aspect ratio');
  const resolution = requiredText(get('resolution'), 'Resolution', 10);
  if (!resolutions.includes(resolution)) throw new UserError('Select a supported resolution');
  const body: IDataObject = { model, duration, aspect_ratio: ratio, resolution, async: true };
  if (prompt) body.prompt = prompt;
  if (image) body.image_url = publicUrl(image);
  const references = referenceUrls(get('referenceImageUrls'));
  if (references.length) body.reference_image_urls = references;
  return body;
}

function publicData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(publicData);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !privateFields.has(key.toLowerCase())
      && !/(^internal(?:_|$)|supplier|upstream|(?:^|_)secret(?:_|$))/i.test(key))
    .map(([key, item]) => [key, publicData(item)]));
}

function videoUrls(value: unknown): string[] {
  const found: string[] = [];
  function walk(node: unknown): void {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== 'object') return;
    for (const [key, item] of Object.entries(node)) {
      if ((key === 'video_url' || key === 'url') && typeof item === 'string' && item.startsWith('https://'))
        found.push(item);
      else if (item && typeof item === 'object') walk(item);
    }
  }
  walk(value);
  return [...new Set(found)];
}

export function taskResult(record: IDataObject): IDataObject {
  const response = object(record.response);
  const data = publicData(response.data ?? record.data ?? null);
  const items = Array.isArray(data) ? data : [];
  const states = items.map(item => String(object(item).state ?? '').toLowerCase()).filter(Boolean);
  const state = String(record.state ?? record.status ?? response.status ?? '').toLowerCase();
  const unfinished = Object.prototype.hasOwnProperty.call(record, 'finished_at') && record.finished_at === null;
  const failed = !unfinished && (response.success === false || record.success === false || Boolean(response.error ?? record.error)
    || ['failed', 'error', 'cancelled', 'canceled', 'rejected'].includes(state)
    || states.some(item => ['failed', 'error', 'cancelled', 'canceled', 'rejected'].includes(item)));
  const urls = videoUrls(data);
  const finished = Boolean(record.finished_at);
  const complete = !failed && !unfinished && (
    ['succeeded', 'success', 'completed', 'complete'].includes(state)
    || (states.length > 0 && states.every(item => ['succeeded', 'success', 'completed', 'complete'].includes(item)))
    || (finished && response.success === true && urls.length > 0));
  return {
    taskId: record.id ?? record.task_id ?? '',
    status: failed ? 'failed' : complete ? 'succeeded' : 'processing',
    finished: failed || complete,
    successful: failed ? false : complete ? true : null,
    videoUrls: complete ? urls : [],
    data: complete ? data as IDataObject | IDataObject[] | null : null,
    error: failed ? { code: 'task_failed', message: 'The task failed; inspect its task or trace ID.' } : null,
    traceId: record.trace_id ?? response.trace_id ?? null,
    cost: publicData(response.cost ?? null) as IDataObject | null,
  };
}

function requestFailure(error: unknown): OperationalError {
  const value = error && typeof error === 'object' ? error as {
    httpCode?: unknown; statusCode?: unknown; response?: { statusCode?: unknown; status?: unknown };
  } : {};
  const code = String(value.httpCode ?? value.statusCode ?? value.response?.statusCode ?? value.response?.status ?? '');
  const status = /^\d{3}$/.test(code) ? code : '';
  return new OperationalError(status
    ? `Ace Data Cloud returned HTTP ${status}. Check the original task or request history before retrying.`
    : 'The Grok Video request did not complete. Check task or request history before retrying; generation may have been charged.');
}

async function request(context: IExecuteFunctions, endpoint: string, body: IDataObject): Promise<IDataObject> {
  let result: unknown;
  try {
    result = await context.helpers.httpRequestWithAuthentication.call(context, 'aceDataGrokVideoApi', {
      method: 'POST', url: `https://api.acedata.cloud${endpoint}`, body,
      json: true, disableFollowRedirect: true, timeout: 60000,
    });
  } catch (error) { throw requestFailure(error); }
  if (!result || typeof result !== 'object' || Array.isArray(result))
    throw new OperationalError('The service returned an unexpected response');
  const value = object(result);
  if (value.success === false || value.error)
    throw new OperationalError('The service rejected the request. Inspect its task or trace ID.');
  return value;
}

export class GrokVideo implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Grok Video by Ace Data Cloud', name: 'grokVideo',
    icon: { light: 'file:icon.svg', dark: 'file:icon.dark.svg' },
    group: ['transform'], version: 1,
    subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
    description: 'Generate a Grok video and retrieve the same task until it finishes',
    defaults: { name: 'Grok Video by Ace Data Cloud' },
    inputs: [NodeConnectionTypes.Main], outputs: [NodeConnectionTypes.Main],
    usableAsTool: true, credentials: [{ name: 'aceDataGrokVideoApi', required: true }], properties,
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const output: INodeExecutionData[] = [];
    for (let index = 0; index < this.getInputData().length; index++) {
      try {
        let hasToken = false;
        try {
          const credentials = await this.getCredentials('aceDataGrokVideoApi');
          hasToken = typeof credentials.apiToken === 'string' && Boolean(credentials.apiToken.trim());
        } catch { /* n8n did not provide a credential. */ }
        if (!hasToken)
          throw new NodeOperationError(this.getNode(), 'A Grok Video by Ace Data Cloud credential is required.');

        const resource = this.getNodeParameter('resource', index) as string;
        const operation = this.getNodeParameter('operation', index) as string;
        if (resource === 'task') {
          const body: IDataObject = operation === 'get'
            ? { action: 'retrieve', id: requiredText(this.getNodeParameter('taskId', index), 'Task ID', 128) }
            : operation === 'getMany'
              ? { action: 'retrieve_batch', ids: taskIds(this.getNodeParameter('taskIds', index)) }
              : {};
          if (!body.action) throw new UserError('Select a supported task operation');
          const result = await request(this, '/grok/tasks', body);
          const records = operation === 'getMany' ? result.items : [result];
          if (!Array.isArray(records)) throw new OperationalError('The service returned an unexpected task list');
          for (const item of records) {
            const record = object(item);
            if (!record.id && !record.task_id) throw new OperationalError('The task was not found');
            output.push({ json: taskResult(record), pairedItem: { item: index } });
          }
          continue;
        }
        if (resource !== 'video' || operation !== 'create')
          throw new UserError('Select a supported Grok Video operation');
        const body = videoBody(name => this.getNodeParameter(name, index, ''));
        const result = await request(this, '/grok/videos', body);
        const taskId = result.task_id ?? object(result.task).id;
        if (typeof taskId !== 'string' || !taskId)
          throw new OperationalError('The service did not return a task ID; inspect request history before retrying');
        output.push({
          json: { taskId, status: 'submitted', finished: false, successful: null, traceId: result.trace_id ?? null },
          pairedItem: { item: index },
        });
      } catch (error) {
        if (!this.continueOnFail())
          throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: index });
        output.push({ json: { error: (error as Error).message }, pairedItem: { item: index } });
      }
    }
    return [output];
  }
}
