#!/usr/bin/env python3
"""Reproducible, explicitly modeled personas. No test scoring or survey submission."""
import argparse
import copy
import hashlib
import json
import math
import random
import statistics
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCHEMA = json.loads((ROOT / 'references/dimensions.json').read_text(encoding='utf-8'))
VERSION = SCHEMA['model_version']
GROUPS = SCHEMA['groups']
TOPICS = ('general', 'gaming', 'ai-decisions', 'education', 'work', 'relationships')
LATENTS = sorted({k for g in GROUPS.values() for d in g['dimensions'].values() for k in d['loadings']})


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def fingerprint(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def stable_seed(*parts):
    return int(fingerprint(parts)[:16], 16)


def clip(value):
    return round(max(0., min(100., value)), 2)


def number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def coordinate(value):
    return number(value) and 0 <= value <= 100


def read(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def save(path, value):
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + '\n', encoding='utf-8')


def validate_schema():
    sources = {s['id'] for s in read(ROOT / 'references/sources.json')['sources']}
    for name, group in GROUPS.items():
        if not set(group['source_ids']) <= sources:
            raise ValueError(f'Unknown source in {name}')
        for key, dim in group['dimensions'].items():
            weights = dim['loadings']
            if not weights or not all(number(w) for w in weights.values()):
                raise ValueError(f'Invalid loading {name}.{key}')
            if sum(w*w for w in weights.values()) >= 1:
                raise ValueError(f'No independent residual in {name}.{key}')


def context_features(person, topic):
    """Author scenarios, not observed outcomes or instrument results."""
    core = person['core']
    get = lambda g, k: core[g][k]
    rng = random.Random(stable_seed(person['person_seed'], 'topic', topic, VERSION))
    mix = lambda *values: clip(statistics.mean(values) + rng.gauss(0, 9))
    independent = lambda: clip(rng.gauss(50, 18))
    if topic == 'general':
        return {'approach_to_new_task': mix(get('tci_concepts','novelty_seeking'), get('self_regulation','flexibility'))}
    if topic == 'gaming':
        return {'autonomous_motivation': independent(), 'controlled_motivation': independent(),
                'time_regulation': mix(get('self_regulation','planning'), get('atq_concepts','inhibitory_control')),
                'recovery_orientation': independent(), 'stimulation_preference': get('impulsivity','sensation_seeking'),
                'engagement': independent()}
    if topic == 'ai-decisions':
        return {'baseline_ai_trust': independent(), 'domain_knowledge': independent(),
                'verification_tendency': mix(get('self_regulation','evaluation'), get('ipip_neo_facets','cautiousness')),
                'initial_confidence': mix(get('resources','self_efficacy'), 100-get('resources','uncertainty_intolerance')),
                'advice_openness': mix(get('bfi2_facets','curiosity'), get('self_regulation','flexibility'))}
    if topic == 'education':
        return {'study_regulation': mix(get('self_regulation','planning'), get('self_regulation','programming')),
                'autonomous_motivation': independent(), 'controlled_motivation': independent(),
                'evaluation_sensitivity': mix(get('bfi2_facets','anxiety'), get('atq_concepts','fear')),
                'subject_experience': independent()}
    if topic == 'work':
        return {'task_planning': get('self_regulation','planning'), 'decision_autonomy': get('self_regulation','independence'),
                'domain_experience': independent(), 'cooperation_tendency': get('tci_concepts','cooperativeness')}
    if topic == 'relationships':
        return {'closeness_expectation': mix(100-get('attachment','avoidance'), get('mpq_concepts','social_closeness')),
                'support_seeking': get('coping_tendencies','support'), 'conflict_patience': get('hexaco_facets','patience'),
                'relationship_context_security': independent()}
    raise ValueError(f'Unknown topic: {topic}')


def episode(person, topic, conditions):
    # Same person/topic/conditions always produces the same modeled episode.
    rng = random.Random(stable_seed(person['person_seed'], 'state', topic, conditions, VERSION))
    stress, support, fatigue = (conditions[k] for k in ('stress','support','fatigue'))
    c = person['core']
    anxiety = c['bfi2_facets']['anxiety']
    recovery = c['resources']['recovery']
    regulation = c['self_regulation']['reliability']
    positive = c['mpq_concepts']['wellbeing']
    state = {
        'anxiety_now': clip(50 + .45*(anxiety-50) + .38*(stress-50) - .12*(support-50) + .12*(fatigue-30) + rng.gauss(0,6)),
        'tension_now': clip(50 + .3*(c['cattell_concepts']['Q4']-50) + .42*(stress-50) + .2*(fatigue-30) + rng.gauss(0,6)),
        'positive_affect_now': clip(50 + .5*(positive-50) + .2*(support-50) - .2*(stress-50) - .2*(fatigue-30) + rng.gauss(0,6)),
        'negative_affect_now': clip(50 + .3*(anxiety-50) + .35*(stress-50) - .12*(support-50) + rng.gauss(0,6)),
        'available_regulation_now': clip(50 + .45*(regulation-50) + .15*(recovery-50) - .25*(fatigue-30) - .12*(stress-50) + rng.gauss(0,6))}
    features = context_features(person, topic)
    eid = fingerprint({'topic':topic,'conditions':conditions,'version':VERSION})[:12]
    return {'episode_id':eid, 'topic':topic, 'time_frame':'modeled_current_situation',
            'conditions':copy.deepcopy(conditions), 'state':state, 'topic_features':features,
            'assumption_status':'author_scenario_uncalibrated',
            'unmeasured_context':{'actual_performance':None, 'diagnosis':None},
            'model_version':VERSION}


def narrative(core):
    # Deliberately only a starter: skill instructs adding contextual examples.
    choices = [('bfi2_facets','sociability','Легко ищет общение','Предпочитает ограниченный круг общения'),
               ('self_regulation','planning','Заранее намечает действия','Чаще строит действия по ходу задачи'),
               ('bfi2_facets','anxiety','Обычно чувствителен к неопределённости','Обычно спокойно встречает неопределённость'),
               ('rtt_concepts','endurance','Переносит продолжительную нагрузку','Нуждается в паузах при длительной нагрузке')]
    result=[]
    for group,key,high,low in choices:
        value=core[group][key]
        result.append(high if value>=65 else low if value<=35 else f"{GROUPS[group]['dimensions'][key]['label_ru']}: промежуточная выраженность в модели")
    return result


def generate(count, seed, topic, age_min, age_max, conditions):
    if count < 1 or count > 10000:
        raise ValueError('count must be 1..10000')
    if not (18 <= age_min <= age_max <= 100):
        raise ValueError('age bounds must satisfy 18 <= min <= max <= 100')
    people=[]
    for i in range(count):
        pseed=stable_seed(seed, i, VERSION)
        rng=random.Random(pseed)
        factors={k:rng.gauss(0,1) for k in LATENTS}
        core={}
        for g, spec in GROUPS.items():
            core[g]={}
            for key,dim in spec['dimensions'].items():
                weights=dim['loadings']
                z=sum(w*factors[k] for k,w in weights.items())
                z += math.sqrt(1-sum(w*w for w in weights.values()))*rng.gauss(0,1)
                core[g][key]=clip(50+18*z)
        # Independent RNG separates fictional age from trait generation.
        bio=random.Random(stable_seed(pseed,'fictional-context'))
        person={'id':f'P-{fingerprint([seed,VERSION])[:6]}-{i+1:05d}', 'data_origin':'modeled',
                'person_seed':pseed,'model_version':VERSION,
                'fictional_context':{'age':bio.randint(age_min,age_max), 'language':'ru',
                                     'gender':None, 'occupation':None, 'location':None},
                'core':core,'core_fingerprint':fingerprint(core),
                'unknown_dimensions':{g:dict(spec['unknown_dimensions']) for g,spec in GROUPS.items() if spec['unknown_dimensions']},
                'unknowns':{'medical_history':None,'trauma_history':None,'measured_intelligence':None,'real_identity':None},
                'narrative_starter':narrative(core),'authored_edits':[], 'episodes':[]}
        person['episodes'].append(episode(person,topic,conditions))
        people.append(person)
    return {'schema_version':'1','model_version':VERSION,'data_origin':'modeled',
            'purpose':'coverage_for_educational_simulation',
            'coordinate_semantics':'author_coordinates_0_100_not_test_scores_or_percentiles',
            'calibration':'none','generator':{'seed':seed,'count':count,'age_min':age_min,'age_max':age_max},
            'source_registry':'references/sources.json','personas':people}


def validate(data):
    errors=[]; warnings=[]
    if data.get('data_origin')!='modeled': errors.append('Missing modeled origin on cohort')
    if data.get('model_version')!=VERSION: errors.append('Unsupported model version')
    if data.get('coordinate_semantics')!='author_coordinates_0_100_not_test_scores_or_percentiles': errors.append('Wrong coordinate semantics')
    if data.get('purpose')!='coverage_for_educational_simulation': errors.append('Unknown purpose; record explicit scenario purpose without empirical claims')
    people=data.get('personas',[])
    if not isinstance(people,list) or not people:
        return {'ok':False,'errors':errors+['No personas list'],'warnings':warnings}
    gen=data.get('generator',{})
    if gen.get('count')!=len(people): errors.append('Count mismatch')
    if not isinstance(gen.get('seed'),int): errors.append('Missing seed')
    ids=set(); fingerprints=set(); columns={}
    for index,p in enumerate(people):
        label=p.get('id',f'index-{index}')
        if label in ids: errors.append(f'{label}: duplicate id')
        ids.add(label)
        if p.get('data_origin')!='modeled': errors.append(f'{label}: missing modeled origin')
        if p.get('model_version')!=VERSION or not isinstance(p.get('person_seed'),int): errors.append(f'{label}: version/seed invalid')
        age=p.get('fictional_context',{}).get('age')
        if not isinstance(age,int) or not gen.get('age_min',18)<=age<=gen.get('age_max',100): errors.append(f'{label}: age invalid')
        core=p.get('core',{})
        if set(core)!=set(GROUPS): errors.append(f'{label}: core groups mismatch')
        for g,spec in GROUPS.items():
            values=core.get(g,{})
            if set(values)!=set(spec['dimensions']): errors.append(f'{label}: coordinates mismatch in {g}')
            for key,value in values.items():
                if not coordinate(value): errors.append(f'{label}: invalid {g}.{key}')
                else: columns.setdefault(f'{g}.{key}',[]).append(value)
        try: fp=fingerprint(core)
        except (ValueError,TypeError): fp=None
        if fp != p.get('core_fingerprint'): errors.append(f'{label}: core fingerprint mismatch')
        if fp in fingerprints: warnings.append(f'{label}: identical full core')
        fingerprints.add(fp)
        expected_unknown={g:spec['unknown_dimensions'] for g,spec in GROUPS.items() if spec['unknown_dimensions']}
        if p.get('unknown_dimensions')!=expected_unknown: errors.append(f'{label}: unknown dimension metadata lost')
        if not {'medical_history','trauma_history','measured_intelligence','real_identity'}<=set(p.get('unknowns',{})): errors.append(f'{label}: unknown metadata lost')
        episodes=p.get('episodes',[])
        if not episodes: errors.append(f'{label}: missing episodes')
        for ep in episodes:
            if ep.get('topic') not in TOPICS: errors.append(f'{label}: invalid topic')
            conditions=ep.get('conditions',{})
            if set(conditions)!={'stress','support','fatigue'} or not all(coordinate(x) for x in conditions.values()): errors.append(f'{label}: invalid conditions')
            state=ep.get('state',{})
            expected_state={'anxiety_now','tension_now','positive_affect_now','negative_affect_now','available_regulation_now'}
            if set(state)!=expected_state or not all(coordinate(x) for x in state.values()): errors.append(f'{label}: invalid state')
            features=ep.get('topic_features',{})
            if not features or not all(coordinate(x) for x in features.values()): errors.append(f'{label}: invalid topic features')
            if ep.get('assumption_status')!='author_scenario_uncalibrated' or ep.get('model_version')!=VERSION: errors.append(f'{label}: episode provenance lost')
    if len(people)>=10:
        warnings += [f'Low spread in {k}' for k,v in columns.items() if statistics.pstdev(v)<3]
    spread={k:round(statistics.pstdev(v),2) for k,v in columns.items() if v}
    return {'ok':not errors,'count':len(people),'coordinate_count':sum(len(g['dimensions']) for g in GROUPS.values()),
            'errors':errors,'warnings':warnings,'spread_min':min(spread.values()) if spread else None,
            'spread_median':statistics.median(spread.values()) if spread else None}


def conditions_from(args):
    values={k:getattr(args,k) for k in ('stress','support','fatigue')}
    if not all(coordinate(x) for x in values.values()): raise ValueError('conditions must be 0..100')
    return values


def main():
    validate_schema()
    parser=argparse.ArgumentParser(description=__doc__)
    commands=parser.add_subparsers(dest='command',required=True)
    gen=commands.add_parser('generate'); gen.add_argument('--count',type=int,default=20)
    gen.add_argument('--seed',type=int,default=42); gen.add_argument('--age-min',type=int,default=18)
    gen.add_argument('--age-max',type=int,default=65)
    adapt=commands.add_parser('adapt'); adapt.add_argument('input')
    check=commands.add_parser('validate'); check.add_argument('input')
    for cmd in (gen,adapt):
        cmd.add_argument('--topic',choices=TOPICS,default='general')
        cmd.add_argument('--stress',type=float,default=50); cmd.add_argument('--support',type=float,default=50)
        cmd.add_argument('--fatigue',type=float,default=30); cmd.add_argument('--out',required=True)
    args=parser.parse_args()
    if args.command=='validate':
        result=validate(read(args.input)); print(json.dumps(result,ensure_ascii=False)); return 0 if result['ok'] else 1
    conditions=conditions_from(args)
    if args.command=='generate':
        result=generate(args.count,args.seed,args.topic,args.age_min,args.age_max,conditions)
    else:
        result=read(args.input)
        report=validate(result)
        if not report['ok']: raise ValueError('Input validation failed: '+str(report['errors']))
        for person in result['personas']:
            ep=episode(person,args.topic,conditions)
            if not any(x['episode_id']==ep['episode_id'] for x in person['episodes']): person['episodes'].append(ep)
    report=validate(result)
    if not report['ok']: raise ValueError('Output validation failed: '+str(report['errors']))
    save(args.out,result)
    print(json.dumps({'saved':str(Path(args.out).resolve()),'validation':report},ensure_ascii=False))
    return 0


if __name__=='__main__':
    try: raise SystemExit(main())
    except (ValueError,KeyError,TypeError) as exc:
        raise SystemExit(str(exc))
