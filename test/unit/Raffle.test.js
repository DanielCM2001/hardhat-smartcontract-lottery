const { assert, expect } = require("chai")
const { network, getNamedAccounts, deployments, ethers } = require("hardhat")
const { developmentChains, networkConfig } = require("../../helper-hardhat-config")

!developmentChains.includes(network.name)
    ? describe.skip
    : describe("Raffle Unit Tests", function () {
          let raffle, vrfCoordinatorV2Mock, raffleEntranceFee, deployer, interval
          const chainId = network.config.chainId

          beforeEach(async function () {
              deployer = (await getNamedAccounts()).deployer
              await deployments.fixture(["all"])
              raffle = await ethers.getContract("Raffle", deployer)
              vrfCoordinatorV2Mock = await ethers.getContract("VRFCoordinatorV2Mock", deployer)
              raffleEntranceFee = await raffle.getEntranceFee()
              interval = await raffle.getInterval()
          })

          describe("constructor", function () {
              it("Initializes the raffle correctly", async function () {
                  //Ideally we make our tests have just 1 assert per "it"
                  const raffleState = await raffle.getRaffleState()
                  assert.equal(raffleState.toString(), "0") // Enum 0 = Open state
                  assert.equal(interval.toString(), networkConfig[chainId]["interval"])
              })
          })
          describe("enterRaffle", function () {
              it("reverts when you don't pay enough", async function () {
                  await expect(raffle.enterRaffle()).to.be.revertedWith(
                      "Raffle__NotEnoughETHEntered"
                  )
              })
              it("records players when they enter", async function () {
                  await raffle.enterRaffle({ value: raffleEntranceFee })
                  const playerFromContract = await raffle.getPlayer(0)
                  assert.equal(playerFromContract, deployer)
              })
              it("emits event on enter", async function () {
                  await expect(raffle.enterRaffle({ value: raffleEntranceFee })).to.emit(
                      raffle,
                      "RaffleEnter"
                  )
              })
              it("doesn't allow entrance when raffle is calculating", async function () {
                  await raffle.enterRaffle({ value: raffleEntranceFee })
                  await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                  await network.provider.send("evm_mine", [])
                  // We pretend to be a Chainlink Keeper
                  await raffle.performUpkeep([])
                  await expect(raffle.enterRaffle({ value: raffleEntranceFee })).to.be.revertedWith(
                      "Raffle__NotOpen"
                  )
              })
              describe("checkUpkeep", function () {
                  it("returns false if people haven't sent any ETH", async function () {
                      await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                      await network.provider.send("evm_mine", [])
                      const { upkeepNeeded } = await raffle.callStatic.checkUpkeep([])
                      assert(!upkeepNeeded)
                  })
                  it("returns false if enough time hasn't passed", async function () {
                      await raffle.enterRaffle({ value: raffleEntranceFee })
                      await network.provider.send("evm_increaseTime", [interval.toNumber() - 1])
                      await network.provider.send("evm_mine", [])
                      const { upkeepNeeded } = await raffle.callStatic.checkUpkeep([])
                      assert(!upkeepNeeded)
                  })
                  it("returns true if enough time has passed, has players, balance and state is open", async function () {
                      await raffle.enterRaffle({ value: raffleEntranceFee })
                      await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                      await network.provider.send("evm_mine", [])
                      const { upkeepNeeded } = await raffle.callStatic.checkUpkeep([])
                      assert(upkeepNeeded)
                  })
                  it("returns false if raffle isn't open", async function () {
                      await raffle.enterRaffle({ value: raffleEntranceFee })
                      await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                      await network.provider.send("evm_mine", [])
                      await raffle.performUpkeep([])
                      const raffleState = await raffle.getRaffleState()
                      const { upkeepNeeded } = await raffle.callStatic.checkUpkeep([])
                      assert.equal(raffleState.toString(), "1")
                      assert.equal(upkeepNeeded, false)
                  })
              })
              describe("performUpkeep", function () {
                  it("can only run if checkUpkeep is true", async function () {
                      await raffle.enterRaffle({ value: raffleEntranceFee })
                      await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                      await network.provider.send("evm_mine", [])
                      const tx = await raffle.performUpkeep([])
                      assert(tx)
                  })
                  it("reverts when checkUpkeep is false", async function () {
                      await expect(raffle.performUpkeep([])).to.be.revertedWith(
                          "Raffle__UpkeepNotNeeded"
                      )
                  })
                  it("updates the raffle state, emits an event and calls the vrf coordinator", async function () {
                      await raffle.enterRaffle({ value: raffleEntranceFee })
                      await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                      await network.provider.send("evm_mine", [])
                      const txResponse = await raffle.performUpkeep([])
                      const txReceipt = await txResponse.wait(1)
                      const raffleState = await raffle.getRaffleState()
                      const requestId = txReceipt.events[1].args.requestId
                      assert(raffleState.toString() == "1") // Enum 1 = Calculating state
                      assert(requestId.toNumber() > 0)
                  })
              })
              describe("fulfillRandomWords", function () {
                  beforeEach(async function () {
                      await raffle.enterRaffle({ value: raffleEntranceFee })
                      await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                      await network.provider.send("evm_mine", [])
                  })
                  it("can only be called after performUpkeep", async function () {
                      await expect(
                          vrfCoordinatorV2Mock.fulfillRandomWords(0, raffle.address)
                      ).to.be.revertedWith("nonexistent request")
                      await expect(
                          vrfCoordinatorV2Mock.fulfillRandomWords(1, raffle.address)
                      ).to.be.revertedWith("nonexistent request")
                  })
                  it("picks a winner, resets the lottery and sends the money", async function () {
                      const additionalEntrances = 3
                      const startingAccountIndex = 1 // Since deployer is 0
                      const accounts = await ethers.getSigners()
                      for (
                          let i = startingAccountIndex;
                          i < startingAccountIndex + additionalEntrances;
                          i++
                      ) {
                          const accountConnectedRaffle = raffle.connect(accounts[i])
                          await accountConnectedRaffle.enterRaffle({ value: raffleEntranceFee })
                      }

                      const startingTimeStamp = await raffle.getLatestTimeStamp()

                      // performUpkeep (mock being Chainlink Keepers)
                      // fulfillRandomWords (mock being the Chainlink VRF)
                      // We will have to wait for the fulfillRandomWords to be called
                      await new Promise(async (resolve, reject) => {
                          raffle.once("WinnerPicked", async () => {
                              console.log("Found the event!")
                              try {
                                  const recentWinner = await raffle.getRecentWinner()
                                  console.log(recentWinner)
                                  const raffleState = await raffle.getRaffleState()
                                  const endingTimeStamp = await raffle.getLatestTimeStamp()
                                  const numPlayers = await raffle.getNumberOfPlayers()
                                  const winnerEndingBalance = await accounts[1].getBalance()
                                  assert.equal(numPlayers.toString(), "0")
                                  assert.equal(raffleState.toString(), "0") //State should be back to Open
                                  assert(endingTimeStamp > startingTimeStamp)

                                  assert.equal(
                                      winnerEndingBalance.toString(),
                                      winnerStartingBalance.add(
                                          raffleEntranceFee
                                              .mul(additionalEntrances)
                                              .add(raffleEntranceFee)
                                              .toString()
                                      )
                                  )
                              } catch (e) {
                                  reject(e)
                              }
                              resolve()
                          })
                          //Setting up the listener
                          //Below, we will fire the event, and the listener will pick it up and resolve it
                          const tx = await raffle.performUpkeep([])
                          const txReceipt = await tx.wait(1)
                          const winnerStartingBalance = await accounts[1].getBalance()
                          await vrfCoordinatorV2Mock.fulfillRandomWords(
                              //We get the vrfCoordinatorV2Mock and have it call fulfillRandomWords
                              //which takes the requestId that we get from the txReceipt and the consumer address
                              txReceipt.events[1].args.requestId,
                              raffle.address
                          )
                      })
                  })
              })
          })
      })
