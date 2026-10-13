#!/usr/bin/env python3
"""One JSON job on stdin, one JSON result on stdout. No files or network written."""
import copy
import json
import re
import sys
import personas as model

PROTOCOL = '1'
MAX_COUNT = 1000
MAX_BYTES = 25_000_000
ORIGIN = 'modeled'


def keys(value, expected, label):
    if not isinstance(value, dict) or set(value) != set(expected):
        raise ValueError(f'{label}: unexpected or missing fields')


def integer(value, low, high, label):
    if type(value) is not int or not low <= value <= high:
        raise ValueError(f'{label}: integer outside permitted range')


def scenario(params, generation=False):
    fields = ['topic', 'conditions']
    if generation:
        fields += ['count', 'seed', 'age_min', 'age_max']
    keys(params, fields, 'parameters')
    if params['topic'] not in model.TOPICS:
        raise ValueError('topic: unsupported adapter; extend the model explicitly')
    keys(params['conditions'], ['stress', 'support', 'fatigue'], 'conditions')
    if not all(model.coordinate(v) for v in params['conditions'].values()):
        raise ValueError('conditions: coordinates must be finite numbers 0..100')
    params['conditions'] = {k: float(v) for k, v in params['conditions'].items()}
    if generation:
        integer(params['count'], 1, MAX_COUNT, 'count')
        integer(params['seed'], -(2**53-1), 2**53-1, 'seed')
        integer(params['age_min'], 18, 100, 'age_min')
        integer(params['age_max'], params['age_min'], 100, 'age_max')


def from_wire(cohort):
    value = copy.deepcopy(cohort)
    if not isinstance(value, dict) or value.get('schema_version') != '1':
        raise ValueError('cohort: unsupported schema')
    keys(value, ['schema_version', 'model_version', 'data_origin', 'purpose', 'coordinate_semantics',
                 'calibration', 'generator', 'source_registry', 'personas'], 'cohort')
    people = value.get('personas')
    if not isinstance(people, list) or not 1 <= len(people) <= MAX_COUNT:
        raise ValueError('cohort: invalid persona count')
    gen = value.get('generator')
    keys(gen, ['seed', 'count', 'age_min', 'age_max'], 'generator')
    integer(gen['seed'], -(2**53-1), 2**53-1, 'seed')
    integer(gen['count'], 1, MAX_COUNT, 'count')
    integer(gen['age_min'], 18, 100, 'age_min')
    integer(gen['age_max'], gen['age_min'], 100, 'age_max')
    if value.get('calibration') != 'none' or value.get('source_registry') != 'references/sources.json':
        raise ValueError('cohort: provenance changed')
    for person in people:
        if not isinstance(person, dict):
            raise ValueError('persona: expected object')
        keys(person, ['id', 'data_origin', 'person_seed', 'model_version', 'fictional_context', 'core',
                      'core_fingerprint', 'unknown_dimensions', 'unknowns', 'narrative_starter',
                      'authored_edits', 'episodes'], 'persona')
        if not isinstance(person['id'], str) or not re.fullmatch(r'P-[a-f0-9]{6}-[0-9]{5}', person['id']):
            raise ValueError('persona: invalid identifier')
        seed = person.get('person_seed')
        if not isinstance(seed, str) or not re.fullmatch(r'(0|[1-9][0-9]{0,19})', seed) or int(seed) >= 2**64:
            raise ValueError('person_seed: expected decimal string representing uint64')
        person['person_seed'] = int(seed)
        core = person.get('core')
        if not isinstance(core, dict) or set(core) != set(model.GROUPS):
            raise ValueError('core: groups mismatch')
        for group, spec in model.GROUPS.items():
            values = core[group]
            keys(values, spec['dimensions'], 'core dimensions')
            if not all(model.coordinate(v) for v in values.values()):
                raise ValueError('core: invalid coordinate')
            # JS JSON.stringify omits .0. Restore the canonical float encoding
            # used by the generator before checking the psychological core hash.
            core[group] = {key: float(v) for key, v in values.items()}
        context = person.get('fictional_context')
        keys(context, ['age', 'language', 'gender', 'occupation', 'location'], 'fictional_context')
        integer(context['age'], gen['age_min'], gen['age_max'], 'age')
        if not isinstance(context['language'], str) or not all(context[k] is None or isinstance(context[k], str)
               for k in ['gender', 'occupation', 'location']):
            raise ValueError('fictional_context: invalid text fields')
        if not isinstance(person.get('unknowns'), dict):
            raise ValueError('unknowns: expected object')
        if any(person['unknowns'].get(k, 'missing') is not None for k in
               ['medical_history', 'trauma_history', 'measured_intelligence', 'real_identity']):
            raise ValueError('unknowns: unmeasured facts must remain null')
        eps = person.get('episodes')
        if not isinstance(eps, list) or not 1 <= len(eps) <= 100 or not all(isinstance(ep, dict) for ep in eps):
            raise ValueError('episodes: expected 1..100 objects')
        if len({ep.get('episode_id') for ep in eps}) != len(eps):
            raise ValueError('episodes: duplicate identifiers')
        for ep in eps:
            keys(ep, ['episode_id', 'topic', 'time_frame', 'conditions', 'state', 'topic_features',
                      'assumption_status', 'unmeasured_context', 'model_version'], 'episode')
            if not isinstance(ep['episode_id'], str) or not re.fullmatch(r'[a-f0-9]{12}', ep['episode_id']):
                raise ValueError('episode: invalid identifier')
            if ep['time_frame'] != 'modeled_current_situation':
                raise ValueError('episode: invalid time frame')
            scenario({'topic': ep.get('topic'), 'conditions': ep.get('conditions')})
            ep['conditions'] = {k: float(v) for k, v in ep['conditions'].items()}
            if ep.get('unmeasured_context') != {'actual_performance': None, 'diagnosis': None}:
                raise ValueError('episode: unmeasured facts must remain null')
        if not isinstance(person.get('authored_edits'), list) or not isinstance(person.get('narrative_starter'), list):
            raise ValueError('persona: narrative/history missing')
        if not all(isinstance(s, str) for s in person['narrative_starter']):
            raise ValueError('persona: narrative must contain text')
    report = model.validate(value)
    if not report['ok']:
        raise ValueError('cohort: failed model validation')
    return value


def to_wire(cohort):
    value = copy.deepcopy(cohort)
    for person in value['personas']:
        person['person_seed'] = str(person['person_seed'])
    return value


def process(job):
    if not isinstance(job, dict):
        raise ValueError('job: expected object')
    operation = job.get('operation')
    fields = ['protocol_version', 'request_id', 'operation', 'data_origin']
    if operation in ('generate', 'adapt'):
        fields += ['parameters']
    if operation in ('adapt', 'validate'):
        fields += ['cohort']
    keys(job, fields, 'job')
    if operation not in ('generate', 'adapt', 'validate'):
        raise ValueError('operation: unsupported')
    if job['protocol_version'] != PROTOCOL or job['data_origin'] != ORIGIN:
        raise ValueError('job: unsupported protocol or origin')
    if not isinstance(job['request_id'], str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,80}', job['request_id']):
        raise ValueError('request_id: use 1..80 ASCII letters, digits, hyphens or underscores')
    model.validate_schema()
    if operation == 'generate':
        p = job['parameters']
        scenario(p, True)
        cohort = model.generate(p['count'], p['seed'], p['topic'], p['age_min'], p['age_max'], p['conditions'])
    else:
        cohort = from_wire(job['cohort'])
        if operation == 'adapt':
            scenario(job['parameters'])
            p = job['parameters']
            for person in cohort['personas']:
                ep = model.episode(person, p['topic'], p['conditions'])
                if not any(old['episode_id'] == ep['episode_id'] for old in person['episodes']):
                    if len(person['episodes']) >= 100:
                        raise ValueError('episodes: history limit reached')
                    person['episodes'].append(ep)
    report = model.validate(cohort)
    if not report['ok']:
        raise ValueError('cohort: failed output validation')
    result = {'protocol_version': PROTOCOL, 'request_id': job['request_id'], 'operation': operation,
              'data_origin': ORIGIN, 'ok': True, 'validation': report}
    if operation != 'validate':
        result['cohort'] = to_wire(cohort)
    return result


def main():
    job = None
    try:
        raw = sys.stdin.buffer.read(MAX_BYTES + 1)
        if len(raw) > MAX_BYTES:
            raise ValueError('job: input exceeds 25 MB')
        job = json.loads(raw, parse_constant=lambda _x: (_ for _ in ()).throw(ValueError('non-finite JSON')))
        result = process(job)
    except (ValueError, KeyError, TypeError, AttributeError, OverflowError, RecursionError):
        # Return no input fragments: malformed jobs may contain private data.
        rid = job.get('request_id') if isinstance(job, dict) else None
        rid = rid if isinstance(rid, str) and re.fullmatch(r'[A-Za-z0-9_-]{1,80}', rid) else None
        result = {'protocol_version': PROTOCOL, 'request_id': rid, 'data_origin': ORIGIN,
                  'ok': False, 'error': {'code': 'persona.invalid_job', 'message': 'Job failed protocol/model validation.'}}
    sys.stdout.write(json.dumps(result, ensure_ascii=False, allow_nan=False, separators=(',', ':')) + '\n')
    return 0 if result['ok'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
