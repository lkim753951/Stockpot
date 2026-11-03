/**
 * Fixed text, with no model anywhere near it. It also ships inside the app bundle,
 * so a card still opens when the wifi or the power is the problem.
 */
export interface CrisisCard {
  key: string
  title: string
  call?: { label: string; number: string }
  steps: string[]
}

export const CRISIS_CARDS: CrisisCard[] = [
  {
    key: 'gas', title: 'Gas smell or leak',
    call: { label: 'Call 0800 111 999', number: '08001119999' },
    steps: [
      'Open windows and doors.',
      "Turn off the gas at the meter. If the meter is in a cellar, don't go down to it.",
      "No switches and no flames. Don't turn anything on or off.",
      'Call the gas emergency line on 0800 111 999.',
      'Get everyone out and wait outside.',
    ],
  },
  {
    key: 'power', title: 'Power cut',
    call: { label: 'Call 105', number: '105' },
    steps: [
      'Turn off cookers, fryers and grills.',
      'Keep fridge and freezer doors shut.',
      'Look at the fuse board. Reset a tripped switch once. If it trips again, leave it off.',
      'Call 105 to report a power cut. It is free.',
      'Write down the time the power went off.',
      'If you smell burning or see damaged wires, leave and call 999.',
    ],
  },
  {
    key: 'water', title: 'No water',
    steps: [
      "Stop preparing food if staff can't wash their hands.",
      'Check the stopcock, and ask neighbours if they have water.',
      'Call your water supplier.',
      'Use bottled water for drinks. Tell the owner before serving anything else.',
      'When the water returns, run the taps until it is clear.',
    ],
  },
  {
    key: 'fridge', title: 'Fridge failure',
    steps: [
      'Check the plug and the door, then write down the temperature and the time.',
      'Move chilled food into a working fridge at 8°C or below.',
      'Keep the failed fridge shut if there is nowhere to move the food.',
      "Throw away high-risk food that has been above 8°C for four hours, or if you don't know how long.",
      'Mark the fridge out of use and call the engineer.',
    ],
  },
  {
    key: 'wifi', title: 'Wifi down',
    steps: [
      'Turn the router off, wait 30 seconds and turn it on.',
      'Connect the till or card reader to a phone hotspot if it allows this.',
      'Write orders on paper until it is back.',
      'If cards are down, tell customers before they order.',
      'Call your broadband provider.',
    ],
  },
]
