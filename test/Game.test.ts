import {expect} from './chai-setup';
import {
  ethers,
  deployments,
  getUnnamedAccounts,
  getNamedAccounts,
} from 'hardhat';

const advanceToGameStart = async (timestamp: number) => {
  await ethers.provider.send('evm_setNextBlockTimestamp', [timestamp]);
  await ethers.provider.send('evm_mine', []);
};

const advanceTime = async (seconds: number) => {
  await ethers.provider.send('evm_increaseTime', [seconds]);
  await ethers.provider.send('evm_mine', []);
};

const setup = deployments.createFixture(async () => {
  await deployments.fixture('Game');
  await deployments.fixture('TestGame');
  const {deployer} = await getNamedAccounts();
  const others = await getUnnamedAccounts();
  const game = await ethers.getContract('Game');
  const testGame = await ethers.getContract('TestGame');
  return {
    deployer,
    Game: game,
    TestGame: testGame,
    others: others.map((acc: string) => ({address: acc})),
  };
});

describe('Game', function () {
  context('Before Game Start', async function () {
    it('initializes correct nft depositors', async function () {
      const {Game: g} = await setup();
      expect(
        await g.depositors('0x465DCa9995D6c2a81A9Be80fBCeD5a770dEE3daE')
      ).to.equal(true);
      expect(
        await g.depositors('0x426923E98e347158D5C471a9391edaEa95516473')
      ).to.equal(true);
      // expect(
      //   await g.depositors('0x63A556c75443b176b5A4078e929e38bEb37a1ff2')
      // ).to.equal(true);
    });

    it('disallows non-whitelisted depositors', async function () {
      const {Game: g} = await setup();
      // deposits with owner account
      await expect(
        g.deposit([ethers.constants.AddressZero], [0])
      ).to.be.revertedWith('you are not allowed to deposit');
    });

    it('adds new whitelisted depositors', async function () {
      const {Game: g, deployer: owner} = await setup();
      await g.addDepositors([owner]);
      expect(await g.depositors(owner)).to.equal(true);
    });

    it('is before game start initially', async function () {
      const {Game: g} = await setup();
      const timeBeforeGameStart = await g.timeBeforeGameStart();
      const latestBlock = await ethers.provider.getBlock('latest');
      const now = latestBlock.timestamp;
      expect(now).to.be.lessThan(timeBeforeGameStart);
    });

    it('disallows to call inits before game start', async function () {
      const {Game: g} = await setup();
      await expect(g.initStart(0, [])).to.be.revertedWith(
        'game has not started yet'
      );
      await expect(g.initEnd(Array(255).fill(0), 0)).to.be.revertedWith(
        'game has not started yet'
      );
    });

    it('successfully init starts the game', async function () {
      const {Game: g} = await setup();
      const timeBeforeGameStart = await g.timeBeforeGameStart();
      await advanceToGameStart(timeBeforeGameStart + 2 * 900);
      // chainlink call
      await expect(g.initStart(1, [0])).to.be.revertedWith(
        'function call to a non-contract account'
      );
    });
  });

  context('Buy Ticket', async function () {
    it('buys the ticket', async function () {
      const {TestGame: g, deployer} = await setup();
      const ticketPrice = await g.ticketPrice();
      await g.buyTicket({value: ticketPrice.toString()});
      const [firstPlayer, num] = await g.player(1);
      expect(firstPlayer).to.equal(deployer);
      expect(num).to.equal(1);
    });

    it('forbids the same acc to buy more than one ticket', async function () {
      const {TestGame: g} = await setup();
      const ticketPrice = await g.ticketPrice();
      await g.buyTicket({value: ticketPrice.toString()});
      await expect(
        g.buyTicket({value: ticketPrice.toString()})
      ).to.be.revertedWith('cant buy more');
    });
  });

  context('Game Start - Unwrap', async function () {
    it('is bueno', async function () {
      const {TestGame: g} = await setup();
      let lastBlock = await ethers.provider.getBlock('latest');
      let timestamp = lastBlock.timestamp;
      await g.testSetLastAction(timestamp);
      const ticketPrice = await g.ticketPrice();
      await g.buyTicket({value: ticketPrice.toString()});
      await advanceTime(1);
      // for testing purposes setting the playersOrder here without entropy
      // in prod, we will construct playersOrder from chainlink's entropies
      // playersOrder is 1-indexed, thus 255 players in total
      const playersOrder = Array(255).fill(0);
      // players[playersOrder] is owner
      playersOrder[0] = 1;
      await g.testSetPlayersOrder(playersOrder);
      await g.unwrap('0');
      expect(await g.currPlayer()).to.equal(1);
      lastBlock = await ethers.provider.getBlock('latest');
      timestamp = lastBlock.timestamp;
      expect(await g.lastAction()).to.equal(timestamp);
    });

    it('forbids to unwrap if not your turn', async function () {
      const {TestGame: g} = await setup();
      const lastBlock = await ethers.provider.getBlock('latest');
      const timestamp = lastBlock.timestamp;
      await g.testSetLastAction(timestamp);
      const ticketPrice = await g.ticketPrice();
      await g.buyTicket({value: ticketPrice.toString()});
      await advanceTime(1);
      const playersOrder = Array(255).fill(0);
      playersOrder[0] = 2;
      await g.testSetPlayersOrder(playersOrder);
      await expect(g.unwrap('0')).to.be.revertedWith('not your turn');
    });

    it('correctly handles 1 missed', async function () {
      const {TestGame: g, others} = await setup();
      let lastBlock = await ethers.provider.getBlock('latest');
      const timestamp = lastBlock.timestamp;
      await g.testSetLastAction(timestamp);
      const ticketPrice = await g.ticketPrice();
      const contract = await ethers.getContract('TestGame', others[1].address);
      await g.buyTicket({value: ticketPrice.toString()});
      await contract.buyTicket({value: ticketPrice.toString()});
      await advanceTime(10800);
      const playersOrder = Array(255).fill(0);
      playersOrder[0] = 1;
      playersOrder[1] = 2;
      await g.testSetPlayersOrder(playersOrder);
      await expect(g.unwrap(0)).to.be.revertedWith('playersSkipped not zero');
      await contract.unwrap(1);
      // next player index
      expect(await contract.currPlayer()).to.be.equal(2);
      lastBlock = await ethers.provider.getBlock('latest');
      expect(await contract.lastAction()).to.be.equal(lastBlock.timestamp);
    });

    it('correctly handles 2 missed', async function () {
      const {TestGame: g, others} = await setup();
      let lastBlock = await ethers.provider.getBlock('latest');
      const timestamp = lastBlock.timestamp;
      await g.testSetLastAction(timestamp);
      const ticketPrice = await g.ticketPrice();
      const c1 = await ethers.getContract('TestGame', others[1].address);
      const c2 = await ethers.getContract('TestGame', others[2].address);
      await g.buyTicket({value: ticketPrice.toString()});
      await c1.buyTicket({value: ticketPrice.toString()});
      await c2.buyTicket({value: ticketPrice.toString()});
      await advanceTime(2 * 10800);
      const playersOrder = Array(255).fill(0);
      playersOrder[0] = 3;
      playersOrder[1] = 1;
      playersOrder[2] = 2;
      await g.testSetPlayersOrder(playersOrder);
      await expect(c2.unwrap(0)).to.be.revertedWith('playersSkipped not zero');
      await expect(c2.unwrap(2)).to.be.revertedWith('not your turn');
      await expect(g.unwrap(0)).to.be.revertedWith('playersSkipped not zero');
      await expect(g.unwrap(2)).to.be.revertedWith('not your turn');
      await expect(c1.unwrap(0)).to.be.revertedWith('playersSkipped not zero');
      await c1.unwrap(2);
      expect(await c1.currPlayer()).to.be.equal(3);
      lastBlock = await ethers.provider.getBlock('latest');
      expect(await c1.lastAction()).to.be.equal(lastBlock.timestamp);
    });

    it('disallows the person that missed the turn to unwrap', async function () {
      const {TestGame: g, others} = await setup();
      const lastBlock = await ethers.provider.getBlock('latest');
      const timestamp = lastBlock.timestamp;
      await g.testSetLastAction(timestamp);
      const ticketPrice = await g.ticketPrice();
      const contract = await ethers.getContract('TestGame', others[1].address);
      await g.buyTicket({value: ticketPrice.toString()});
      await contract.buyTicket({value: ticketPrice.toString()});
      await advanceTime(10800);
      const playersOrder = Array(255).fill(0);
      playersOrder[0] = 1;
      playersOrder[1] = 2;
      await g.testSetPlayersOrder(playersOrder);
      await expect(g.unwrap(1)).to.be.revertedWith('not your turn');
    });
  });
});
