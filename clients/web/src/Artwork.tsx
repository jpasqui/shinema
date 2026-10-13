import {useId} from 'react';

/** Original vector artwork for generated demo clips; no external images. */
export function Artwork({kind=0,className='',wide=false}:{kind?:number;className?:string;wide?:boolean}){
  const uid='art'+useId().replace(/[^a-zA-Z0-9]/g,'');
  const ref=(name:string)=>`url(#${uid}-${name})`;
  const palette=kind===1 ? ['#d5956b','#743b2d','#291c20'] : kind===2 ? ['#a1a7a5','#596561','#172320'] : ['#57646d','#19282f','#0b141a'];
  return <svg className={`artwork ${className}`} viewBox={wide?'0 0 1600 780':'0 0 1600 1100'} preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
    <defs>
      <linearGradient id={`${uid}-sky`} x1="0" y1="0" x2="0" y2="1"><stop stopColor={palette[0]}/><stop offset=".7" stopColor={palette[1]}/><stop offset="1" stopColor={palette[2]}/></linearGradient>
      <linearGradient id={`${uid}-stone`} x1="0" y1="0" x2="1" y2="1"><stop stopColor={kind===1?'#d59974':'#bbc2bf'}/><stop offset=".45" stopColor={kind===1?'#835138':'#687c7a'}/><stop offset="1" stopColor={palette[2]}/></linearGradient>
      <linearGradient id={`${uid}-sand`} x1="0" y1="0" x2="0" y2="1"><stop stopColor={kind===1?'#b86b43':'#708187'}/><stop offset="1" stopColor={palette[2]}/></linearGradient>
      <radialGradient id={`${uid}-moon`} cx=".3" cy=".25" r=".9"><stop stopColor="#efe9d8"/><stop offset=".55" stopColor="#c2c4b6"/><stop offset="1" stopColor="#6b827e"/></radialGradient>
      <linearGradient id={`${uid}-mist`} x1="0" y1="0" x2="0" y2="1"><stop stopColor="#d2d7cb" stopOpacity="0"/><stop offset="1" stopColor="#d2d7cb" stopOpacity=".23"/></linearGradient>
      <filter id={`${uid}-grain`} x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency=".74" numOctaves="3" seed={kind+8} stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/><feComponentTransfer><feFuncA type="linear" slope=".18"/></feComponentTransfer></filter>
      <mask id={`${uid}-crescent`}><rect width="1600" height="1100" fill="white"/><circle cx="971" cy="292" r="228" fill="black"/></mask>
    </defs>
    <rect width="1600" height="1100" fill={ref('sky')}/>
    {kind===1 ? <>
      <circle cx="845" cy="355" r="174" fill="#f0cda2"/>
      <path d="M0 677 246 488 416 635 603 535 851 714 1145 498 1412 645 1600 565V1100H0Z" fill="#81533e"/>
      <path d="m246 488 170 147-111-39-122 72-183 9Z" fill="#b77d57"/>
      <path d="m1145 498 267 147-144-26-164 185-185-81Z" fill="#ba8762"/>
      <path d="M0 845Q320 720 577 881T1180 857Q1375 804 1600 827V1100H0Z" fill={ref('sand')}/>
      <path d="M0 1010Q434 825 735 987T1600 930V1100H0Z" fill="#382821"/>
      <path d="M460 1100q82-170 437-204-163 48-228 204" fill="#c58b5a" opacity=".45"/>
    </> : kind===2 ? <>
      <circle cx="1070" cy="404" r="183" fill="#b7543e"/>
      <path d="M200 930V382L647 140v790Z" fill={ref('stone')}/>
      <path d="m647 140 81 79v711h-81Z" fill="#30403e"/>
      <path d="M840 930V604l395-232v558Z" fill="#9da9a5"/>
      <path d="m1235 372 64 65v493h-64Z" fill="#3b504a"/>
      <path d="M0 960 520 738l432 188 648-193v367H0Z" fill="#233732"/>
      <path d="M0 1100 520 738 605 775 359 1100Z" fill="#607b6b"/>
      <path d="M520 738 952 926l-51 13-418-180Z" fill="#ccd0bb" opacity=".6"/>
      <path d="M1020 1100v-60h70v-55h70v-55h70v-55h70v-55h70v280Z" fill="#61766b"/>
      {[0,1,2,3,4,5,6,7].map(index=><path key={index} d={`M${250+index*45} ${860-index*24}v-350`} stroke="#e3e6d5" strokeOpacity=".13" strokeWidth="2"/>)}
    </> : <>
      <circle cx="865" cy="336" r="225" fill={ref('moon')} mask={ref('crescent')}/>
      <g fill="#d9e1d7" opacity=".55"><circle cx="382" cy="147" r="2"/><circle cx="1198" cy="257" r="2.5"/><circle cx="628" cy="84" r="1.5"/><circle cx="1268" cy="115" r="1.4"/></g>
      <path d="M0 776 209 680 403 753 598 589 844 765 1121 590 1435 767 1600 723V1100H0Z" fill="#26393e"/>
      <path d="m598 589 246 176-114-42-75-11-97 81-155-40Z" fill="#5e6f73"/>
      <path d="m1121 590 314 177-181-63-111 115-299-54Z" fill="#465e62"/>
      <path d="M0 877Q334 722 731 923T1600 825V1100H0Z" fill={ref('sand')}/>
      <path d="M0 1100V1053q405-268 823-78t777-6v131Z" fill="#14252b"/>
      <path d="M158 1100q287-148 581-124-288 7-443 124" fill="#b5b9ac" opacity=".45"/>
    </>}
    <rect y="480" width="1600" height="300" fill={ref('mist')}/>
    <rect width="1600" height="1100" filter={ref('grain')} style={{mixBlendMode:'soft-light'}}/>
  </svg>;
}
