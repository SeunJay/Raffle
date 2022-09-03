const { assert, expect } = require("chai");
const { deployments, ethers, getNamedAccounts, network } = require("hardhat");
const {
  developmentChains,
  networkConfig,
} = require("../../helper-hardhat-config");

!developmentChains.includes(network.name)
  ? describe.skip
  : describe("Raffle Contract", () => {
      let raffle, vrfCoordinatorV2Mock, raffleEntranceFee, deployer, interval;
      const chainId = network.config.chainId;

      beforeEach(async () => {
        deployer = (await getNamedAccounts()).deployer;
        await deployments.fixture(["all"]);

        raffle = await ethers.getContract("Raffle", deployer);

        vrfCoordinatorV2Mock = await ethers.getContract(
          "VRFCoordinatorV2Mock",
          deployer
        );

        raffleEntranceFee = await raffle.getEntranceFee();

        interval = await raffle.getInterval();
      });

      describe("constructor", () => {
        it("initializes the raffle contract correctly", async () => {
          const raffleState = await raffle.getRaffleState();
          // const raffleInterval = await raffle.getInterval();
          assert.equal(raffleState.toString(), "0");
          assert.equal(interval.toString(), networkConfig[chainId]["interval"]);
        });
      });

      describe("enter raffle", () => {
        it("reverts when you don't pay enough", async () => {
          await expect(raffle.enterRaffle()).to.be.revertedWith(
            "Raffle__NotEnoughETHEntered"
          );
        });

        it("records player correctly with enough entrance fee", async () => {
          await raffle.enterRaffle({ value: raffleEntranceFee });

          const playerFromContract = await raffle.getPlayer(0);
          assert.equal(playerFromContract, deployer);
        });

        it("emits an event on enter", async () => {
          await expect(
            raffle.enterRaffle({ value: raffleEntranceFee })
          ).to.emit(raffle, "RaffleEnter");
        });

        it("doesn't allow entrance when raffle calculating", async () => {
          await raffle.enterRaffle({ value: raffleEntranceFee });
          await network.provider.send("evm_increaseTime", [
            interval.toNumber() + 1,
          ]);

          await network.provider.request({ method: "evm_mine", params: [] });
          // we pretend to be a chainlink keeper
          await raffle.performUpkeep([]);

          await expect(
            raffle.enterRaffle({ value: raffleEntranceFee })
          ).to.be.revertedWith("Raffle__NotOpen");
        });

        describe("check up keep", () => {
          it("returns false if no one has entered raffle with ETH", async () => {
            await network.provider.send("evm_increaseTime", [
              interval.toNumber() + 1,
            ]);

            await network.provider.request({ method: "evm_mine", params: [] });
            const { upkeepNeeded } = await raffle.callStatic.checkUpkeep("0x");
            assert.equal(upkeepNeeded, false);
          });

          it("returns false if raffle isn't open", async () => {
            await raffle.enterRaffle({ value: raffleEntranceFee });
            await network.provider.send("evm_increaseTime", [
              interval.toNumber() + 1,
            ]);
            await network.provider.request({ method: "evm_mine", params: [] });
            await raffle.performUpkeep([]);
            const raffleState = await raffle.getRaffleState();
            const { upkeepNeeded } = await raffle.callStatic.checkUpkeep("0x");
            assert.equal(raffleState.toString(), "1");
            assert.equal(upkeepNeeded, false);
          });

          it("returns false if enough time hasn't passed", async () => {
            await raffle.enterRaffle({ value: raffleEntranceFee });
            await network.provider.send("evm_increaseTime", [
              interval.toNumber() - 5,
            ]); // use a higher number here if this test fails
            await network.provider.request({ method: "evm_mine", params: [] });
            const { upkeepNeeded } = await raffle.callStatic.checkUpkeep("0x"); // upkeepNeeded = (timePassed && isOpen && hasBalance && hasPlayers)
            assert(!upkeepNeeded);
          });
          it("returns true if enough time has passed, has players, eth, and is open", async () => {
            await raffle.enterRaffle({ value: raffleEntranceFee });
            await network.provider.send("evm_increaseTime", [
              interval.toNumber() + 1,
            ]);
            await network.provider.request({ method: "evm_mine", params: [] });
            const { upkeepNeeded } = await raffle.callStatic.checkUpkeep("0x"); // upkeepNeeded = (timePassed && isOpen && hasBalance && hasPlayers)
            assert(upkeepNeeded);
          });
        });

        describe("perform up keep", () => {
          it("can only run if checkupkeep is true", async () => {
            await raffle.enterRaffle({ value: raffleEntranceFee });
            await network.provider.send("evm_increaseTime", [
              interval.toNumber() + 1,
            ]);
            await network.provider.request({ method: "evm_mine", params: [] });
            const tx = await raffle.performUpkeep("0x");
            assert(tx);
          });

          it("reverts if checkup is false", async () => {
            await expect(raffle.performUpkeep("0x")).to.be.revertedWith(
              "Raffle__UpkeepNotNeeded"
            );
          });
        });

        describe("fulfill random words", () => {
          beforeEach(async () => {
            await raffle.enterRaffle({ value: raffleEntranceFee });
            await network.provider.send("evm_increaseTime", [
              interval.toNumber() + 1,
            ]);
            await network.provider.request({ method: "evm_mine", params: [] });
          });

          it("can only be called after perform up keep", async () => {
            await expect(
              vrfCoordinatorV2Mock.fulfillRandomWords(0, raffle.address) // reverts if not fulfilled
            ).to.be.revertedWith("nonexistent request");
            await expect(
              vrfCoordinatorV2Mock.fulfillRandomWords(1, raffle.address) // reverts if not fulfilled
            ).to.be.revertedWith("nonexistent request");
          });

          it.only("picks a winner, resets, and sends money", async (done) => {
            const additionalEntrances = 3; // to test
            const startingIndex = 2;
            const accounts = await ethers.getSigners();
            for (
              let i = startingIndex;
              i < startingIndex + additionalEntrances;
              i++
            ) {
              // i = 2; i < 5; i=i+1
              raffle = raffle.connect(accounts[i]); // Returns a new instance of the Raffle contract connected to player
              await raffle.enterRaffle({ value: raffleEntranceFee });
            }
            const startingTimeStamp = await raffle.getLastestTimeStamp(); // stores starting timestamp (before we fire our event)

            // This will be more important for our staging tests...
            await new Promise(async (resolve, reject) => {
              raffle.once("WinnerPicked", async () => {
                // event listener for WinnerPicked
                console.log("WinnerPicked event fired!");
                // assert throws an error if it fails, so we need to wrap
                // it in a try/catch so that the promise returns event
                // if it fails.
                try {
                  // Now lets get the ending values...
                  const recentWinner = await raffle.getRecentWinner();
                  const raffleState = await raffle.getRaffleState();
                  const winnerBalance = await accounts[2].getBalance();
                  const endingTimeStamp = await raffle.getLastTimeStamp();
                  await expect(raffle.getPlayer(0)).to.be.reverted;
                  // Comparisons to check if our ending values are correct:
                  assert.equal(recentWinner.toString(), accounts[2].address);
                  assert.equal(raffleState, 0);
                  assert.equal(
                    winnerBalance.toString(),
                    startingBalance // startingBalance + ( (raffleEntranceFee * additionalEntrances) + raffleEntranceFee )
                      .add(
                        raffleEntranceFee
                          .mul(additionalEntrances)
                          .add(raffleEntranceFee)
                      )
                      .toString()
                  );
                  assert(endingTimeStamp > startingTimeStamp);
                  resolve(); // if try passes, resolves the promise
                  done();
                } catch (e) {
                  reject(e); // if try fails, rejects the promise
                }
              });

              // kicking off the event by mocking the chainlink keepers and vrf coordinator
              const tx = await raffle.performUpkeep("0x");
              const txReceipt = await tx.wait(1);
              const startingBalance = await accounts[2].getBalance();
              await vrfCoordinatorV2Mock.fulfillRandomWords(
                txReceipt.events[1].args.requestId,
                raffle.address
              );
            });
          });
        });
      });
    });
