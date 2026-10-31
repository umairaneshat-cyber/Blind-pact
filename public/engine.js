/* Blind Pact game engine: shared by server (authoritative) and browser (odds hints). Rules unchanged from the original single-file game. */
const ROUNDS=8, START_COINS=10, INCOME=5, BOOST=3, BOOST_COST=2;
const TEMPLATES=[
  {name:'Courier Run',diff:9,reward:10},
  {name:'Vault Job',diff:12,reward:17},
  {name:'Caravan Raid',diff:15,reward:25},
  {name:'Crown Heist',diff:18,reward:36}
];
const BOTS={
  saint:{name:'Sister Ada',blurb:'Always cooperates and invests heavily.',betrayP:0,emin:3,emax:5,bmin:1,bmax:1,risk:1},
  snake:{name:'Slick Vic',blurb:'Betrays often and cheaply, where crews tend to fail.',betrayP:.5,emin:2,emax:4,bmin:1,bmax:2,risk:1},
  mirror:{name:'Echo',blurb:'Cooperates until sabotaged, then returns the favor.',betrayP:.05,emin:2,emax:5,bmin:2,bmax:4,risk:1},
  gambler:{name:'Lucky Lu',blurb:'Chases the big contracts and plays loose.',betrayP:.2,emin:3,emax:5,bmin:1,bmax:3,risk:1.5},
  fox:{name:'Reya the Fox',blurb:'Mixes it up so nobody can read her.',betrayP:.28,emin:1,emax:5,bmin:1,bmax:4,risk:1.1}
};
function diceProb(need){
  if(need<=2) return 1; if(need>12) return 0;
  let c=0; for(let a=1;a<=6;a++) for(let b=1;b<=6;b++) if(a+b>=need) c++;
  return c/36;
}
function makeContracts(rng){
  return TEMPLATES.map((t,i)=>{const s=Math.floor(rng()*3)-1; return {id:i,name:t.name,diff:t.diff+s,reward:t.reward+2*s};});
}
function sumBy(a,f){return a.reduce((x,y)=>x+f(y),0);}
function splitReward(reward,items){
  const tot=sumBy(items,i=>i.w);
  const rows=items.map(it=>({pid:it.pid,w:it.w,amt:Math.floor(reward*it.w/tot),rem:(reward*it.w)%tot}));
  let left=reward-sumBy(rows,r=>r.amt);
  rows.slice().sort((a,b)=>b.rem-a.rem||b.w-a.w).forEach(r=>{if(left>0){r.amt++;left--;}});
  return rows;
}
function freshGame(setup){
  const used={};
  const players=setup.slots.slice(0,setup.n).map((s,i)=>{
    let name=s.type==='human'?((s.name||'').trim()||('Player '+(i+1))):BOTS[s.type].name;
    if(used[name]){used[name]++;name=name+' '+used[name];}else used[name]=1;
    return {id:i,name,bot:s.type==='human'?null:s.type,coins:START_COINS,tokens:0,last:0,wasBetrayed:false,
      stats:{landed:0,sabotaged:0,betrays:0}};
  });
  return {players,round:0,contracts:[],choices:{},ledger:[],coinHist:[players.map(p=>p.coins)],result:null,cstate:[],order:[],idx:0};
}
function startRound(S,rng){
  S.round++; S.players.forEach(p=>{p.coins+=INCOME;}); S.contracts=makeContracts(rng); S.choices={};
}
function botDecide(S,p,rng){
  const b=BOTS[p.bot], n=S.players.length, m=S.contracts.length;
  const mates=(n-1)/m, others=mates*3.3;
  let pb=b.betrayP; if(p.bot==='mirror') pb=p.wasBetrayed?.65:.05;
  const betray=rng()<pb;
  let best=null;
  for(const c of S.contracts){
    const lo=betray?b.bmin:b.emin, hi=betray?b.bmax:b.emax;
    for(let e=lo;e<=hi;e++){
      let ev;
      if(betray){
        const ps=diceProb(c.diff+e-others);
        ev=(1-ps)*Math.min(9,3*(Math.round(mates)+1))-e;
      }else{
        const ps=diceProb(c.diff-e-others);
        ev=ps*c.reward*b.risk*(e/(e+others))-e;
      }
      ev+=(rng()-.5)*3;
      if(!best||ev>best.ev) best={ev,c:c.id,e};
    }
  }
  return {contract:best.c,energy:best.e,action:betray?'betray':'coop',boost:p.tokens>=BOOST_COST&&rng()<.7};
}
function resolveRound(S,rng){
  S.players.forEach(p=>{p.wasBetrayed=false;});
  const before=S.players.map(p=>p.coins);
  const byC={}; S.contracts.forEach(c=>{byC[c.id]=[];});
  S.players.forEach(p=>{
    const ch=S.choices[p.id];
    const boost=!!ch.boost&&p.tokens>=BOOST_COST;
    if(boost) p.tokens-=BOOST_COST;
    byC[ch.contract].push({pid:p.id,name:p.name,action:ch.action,energy:ch.energy,boost,eff:ch.energy+(boost?BOOST:0)});
    p.coins-=ch.energy;
    if(ch.action==='betray') p.stats.betrays++;
  });
  const results=S.contracts.map(c=>{
    const entries=byC[c.id];
    const coop=entries.filter(e=>e.action==='coop'), bet=entries.filter(e=>e.action==='betray');
    const r={id:c.id,name:c.name,diff:c.diff,reward:c.reward,entries,empty:entries.length===0,void:coop.length===0,payouts:{},gains:{},tokenTo:[],decisive:false,success:false};
    if(r.void) return r;
    const d1=1+Math.floor(rng()*6), d2=1+Math.floor(rng()*6);
    r.dice=[d1,d2]; r.coopE=sumBy(coop,e=>e.eff); r.betE=sumBy(bet,e=>e.eff);
    r.total=d1+d2+r.coopE; r.target=c.diff+r.betE; r.success=r.total>=r.target;
    if(r.success){
      splitReward(c.reward,coop.map(e=>({pid:e.pid,w:e.eff}))).forEach(x=>{r.payouts[x.pid]=x.amt;});
    }else if(bet.length){
      const g=Math.min(9,3*coop.length);
      bet.forEach(e=>{r.gains[e.pid]=g;});
      coop.forEach(e=>{S.players[e.pid].wasBetrayed=true;S.players[e.pid].stats.sabotaged++;});
      if(r.total>=c.diff){
        r.decisive=true;
        bet.forEach(e=>{S.players[e.pid].tokens++;S.players[e.pid].stats.landed++;r.tokenTo.push(e.pid);});
      }
    }
    return r;
  });
  results.forEach(r=>{
    Object.keys(r.payouts).forEach(k=>{S.players[k].coins+=r.payouts[k];});
    Object.keys(r.gains).forEach(k=>{S.players[k].coins+=r.gains[k];});
  });
  S.players.forEach((p,i)=>{p.last=p.coins-before[i];});
  S.ledger.unshift({round:S.round,results});
  S.coinHist.push(S.players.map(p=>p.coins));
  return results;
}
function rankPlayers(S){
  const arr=S.players.slice().sort((a,b)=>b.coins-a.coins||b.tokens-a.tokens);
  arr.forEach((p,i)=>{
    p.rank=i===0?1:((p.coins===arr[i-1].coins&&p.tokens===arr[i-1].tokens)?arr[i-1].rank:i+1);
  });
  return arr;
}

/* Works in the browser (globals) and in Node (require). */
if(typeof module!=='undefined'&&module.exports){
  module.exports={ROUNDS,START_COINS,INCOME,BOOST,BOOST_COST,TEMPLATES,BOTS,diceProb,makeContracts,freshGame,startRound,botDecide,resolveRound,rankPlayers};
}
